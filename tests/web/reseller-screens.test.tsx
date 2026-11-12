import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { PanelShell } from '../../apps/web/src/reseller/shell';
import { customerPriceList } from '../../apps/web/src/reseller/pages/prices';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi, type Route } from './harness';
import { irt, me, prices, problem, serviceRow, signedIn } from './reseller-fixtures';

/**
 * The wallet, price list, support and «حساب و تنظیمات» screens of the reseller panel.
 */
const API = '/api/reseller/v1';

function visit(path: string) {
  act(() => {
    window.history.replaceState(null, '', path);
    window.dispatchEvent(new Event('popstate'));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  visit('/');
});

function mount(path: string, routes: readonly Route[], user = me()) {
  visit(path);
  const api = stubApi(signedIn(routes, user));
  renderPage(<PanelShell />);
  return api;
}

// --- Wallet -----------------------------------------------------------------------------------

const WALLET = {
  balance: irt('2450000'),
  presets: [irt('500000'), irt('1000000')],
  minimum: irt('100000'),
  maximum: irt('50000000'),
};
const ENTRIES = (direction: string) => ({
  items: [
    {
      id: `e-${direction}`,
      direction: direction === 'DEBIT' ? 'DEBIT' : 'CREDIT',
      reason: direction === 'DEBIT' ? 'PURCHASE' : 'TOPUP_GATEWAY',
      amount: irt('500000'),
      createdAt: '2026-11-09T10:00:00.000Z',
    },
  ],
  nextCursor: null,
});

describe('«کیف پول»', () => {
  const base: Route[] = [
    { url: `${API}/wallet`, body: WALLET },
    { url: `${API}/wallet/entries`, body: ENTRIES('ALL') },
  ];

  it('puts the history BESIDE the top-up form, with «همه / واریز / برداشت»', async () => {
    mount('/r/wallet', base);
    const form = (await screen.findByRole('heading', { name: t('web.rp_topup_title') })).closest(
      'section',
    );
    const history = (await screen.findByText(t('web.rp_history_title'))).closest('section');
    expect(form).not.toBeNull();
    expect(history).not.toBeNull();
    // One row of the same split container: side by side, not stacked in separate blocks.
    expect(form?.closest('.rp-split')).toBe(history?.closest('.rp-split'));
    const filters = screen.getByRole('group', { name: t('web.rp_history_filters') });
    expect(
      within(filters)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['همه', 'واریز', 'برداشت']);
  });

  it('a history filter asks the server for that direction', async () => {
    const api = mount('/r/wallet', [
      ...base,
      { url: `${API}/wallet/entries?direction=DEBIT`, body: ENTRIES('DEBIT') },
    ]);
    await screen.findByText(t('web.ledger_reason_topup_gateway'));
    fireEvent.click(screen.getByRole('button', { name: t('web.rp_history_debit') }));
    expect(await screen.findByText(t('web.ledger_reason_purchase'))).toBeInTheDocument();
    expect(api.calls.some((c) => c.url.includes('direction=DEBIT'))).toBe(true);
  });

  it('quotes an amount and shows the tenant’s enabled methods; in-chat methods are not payable here', async () => {
    const api = mount('/r/wallet', [
      ...base,
      {
        url: `${API}/wallet/topup/quote`,
        method: 'POST',
        body: {
          outcome: 'ROUTES',
          amount: irt('500000'),
          routes: [
            {
              provider: 'MANUAL_TRANSFER',
              kind: 'CARD_TO_CARD',
              name: 'کارت به کارت',
              paysInChat: false,
              giftPercent: 5,
            },
            {
              provider: 'TELEGRAM_STARS',
              kind: 'GATEWAY',
              name: 'استارز',
              paysInChat: true,
              giftPercent: 0,
            },
          ],
        },
      },
    ]);
    fireEvent.click(await screen.findByRole('button', { name: '500,000 تومان' }));
    fireEvent.click(screen.getByRole('button', { name: t('web.rp_topup_continue') }));
    const card = await screen.findByRole('radio', { name: /کارت به کارت/u });
    expect(card).toHaveTextContent(t('web.rp_topup_gift').replace('{n}', '5'));
    expect(screen.getByRole('radio', { name: /استارز/u })).toBeDisabled();
    expect(api.calls.find((c) => c.url.endsWith('/wallet/topup/quote'))?.body).toEqual({
      amount: irt('500000'),
    });
  });

  it('refuses an amount below the minimum with the figure, and offers no method', async () => {
    mount('/r/wallet', [
      ...base,
      {
        url: `${API}/wallet/topup/quote`,
        method: 'POST',
        body: { outcome: 'BELOW_MINIMUM', minimum: irt('100000') },
      },
    ]);
    fireEvent.change(await screen.findByLabelText(t('web.rp_topup_custom')), {
      target: { value: '5000' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.rp_topup_continue') }));
    expect(
      await screen.findByText(t('web.rp_topup_below_min').replace('{amount}', '100,000 تومان')),
    ).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  it('a gateway attempt whose invoice is still being made is read again until its link exists', async () => {
    const attempt = (ready: boolean) => ({
      paymentId: 'pay-gw',
      orderId: null,
      provider: 'TETRAPAY',
      invoiceReady: ready,
      payUrl: ready ? 'https://pay.example.test/i/77' : null,
      paysInChat: false,
      inAppInvoice: false,
      expiresAt: null,
    });
    const status = (ready: boolean) => ({
      paymentId: 'pay-gw',
      method: 'GATEWAY',
      state: 'PENDING',
      transferPending: false,
      receiptFiled: false,
      gateway: attempt(ready),
      order: null,
    });
    const routes: Route[] = [
      ...base,
      {
        url: `${API}/wallet/topup/quote`,
        method: 'POST',
        body: {
          outcome: 'ROUTES',
          amount: irt('500000'),
          routes: [
            {
              provider: 'TETRAPAY',
              kind: 'GATEWAY',
              name: 'درگاه',
              paysInChat: false,
              giftPercent: 0,
            },
          ],
        },
      },
      {
        url: `${API}/wallet/topup`,
        method: 'POST',
        body: { kind: 'GATEWAY', attempt: attempt(false) },
      },
      { url: `${API}/payments/pay-gw`, method: 'GET', body: status(false) },
    ];
    const api = mount('/r/wallet', routes);
    fireEvent.click(await screen.findByRole('button', { name: '500,000 تومان' }));
    fireEvent.click(screen.getByRole('button', { name: t('web.rp_topup_continue') }));
    fireEvent.click(await screen.findByRole('radio', { name: /درگاه/u }));
    fireEvent.click(screen.getByRole('button', { name: t('web.rp_topup_pay') }));
    expect(await screen.findByText(t('web.rp_topup_gateway_waiting'))).toBeInTheDocument();
    // The worker makes the invoice; the screen reads the payment again and draws its link.
    await waitFor(() =>
      expect(api.calls.some((c) => c.method === 'GET' && c.url.endsWith('/payments/pay-gw'))).toBe(
        true,
      ),
    );
    stubApi(
      signedIn(
        routes.map((r) => (r.url.endsWith('/payments/pay-gw') ? { ...r, body: status(true) } : r)),
      ),
    );
    const link = await screen.findByRole(
      'link',
      { name: t('web.rp_topup_gateway_open') },
      { timeout: 6000 },
    );
    expect(link).toHaveAttribute('href', 'https://pay.example.test/i/77');
    expect(screen.queryByText(t('web.rp_topup_gateway_waiting'))).toBeNull();
  }, 15_000);

  it('a gateway attempt whose payment closed without a link says so and stops asking', async () => {
    const pending = {
      paymentId: 'pay-gx',
      orderId: null,
      provider: 'TETRAPAY',
      invoiceReady: false,
      payUrl: null,
      paysInChat: false,
      inAppInvoice: false,
      expiresAt: null,
    };
    mount('/r/wallet', [
      ...base,
      {
        url: `${API}/wallet/topup/quote`,
        method: 'POST',
        body: {
          outcome: 'ROUTES',
          amount: irt('500000'),
          routes: [
            {
              provider: 'TETRAPAY',
              kind: 'GATEWAY',
              name: 'درگاه',
              paysInChat: false,
              giftPercent: 0,
            },
          ],
        },
      },
      { url: `${API}/wallet/topup`, method: 'POST', body: { kind: 'GATEWAY', attempt: pending } },
      {
        url: `${API}/payments/pay-gx`,
        method: 'GET',
        body: {
          paymentId: 'pay-gx',
          method: 'GATEWAY',
          state: 'FAILED',
          transferPending: false,
          receiptFiled: false,
          gateway: pending,
          order: null,
        },
      },
    ]);
    fireEvent.click(await screen.findByRole('button', { name: '500,000 تومان' }));
    fireEvent.click(screen.getByRole('button', { name: t('web.rp_topup_continue') }));
    fireEvent.click(await screen.findByRole('radio', { name: /درگاه/u }));
    fireEvent.click(screen.getByRole('button', { name: t('web.rp_topup_pay') }));
    expect(await screen.findByText(t('web.rp_topup_gateway_closed'))).toBeInTheDocument();
  });

  it('card-to-card: shows where to send exactly how much, then the receipt step', async () => {
    const api = mount('/r/wallet', [
      ...base,
      {
        url: `${API}/wallet/topup/quote`,
        method: 'POST',
        body: {
          outcome: 'ROUTES',
          amount: irt('500000'),
          routes: [
            {
              provider: 'MANUAL_TRANSFER',
              kind: 'CARD_TO_CARD',
              name: 'کارت به کارت',
              paysInChat: false,
              giftPercent: 0,
            },
          ],
        },
      },
      {
        url: `${API}/wallet/topup`,
        method: 'POST',
        body: {
          kind: 'CARD_TO_CARD',
          instruction: {
            paymentId: 'pay-9',
            orderId: null,
            amount: irt('500000'),
            copyAmount: '5000000',
            amountRial: null,
            amountToman: null,
            reference: 'REF-123',
            expiresAt: null,
            destination: {
              cardNumber: '6037 9911 2222 3333',
              copyCardNumber: '6037991122223333',
              holderName: 'علی رضایی',
              bankName: 'ملی',
            },
          },
        },
      },
      {
        url: `${API}/payments/pay-9/transfer-sent`,
        method: 'POST',
        body: { receiptWindowMinutes: 30, reference: 'REF-123' },
      },
    ]);
    fireEvent.click(await screen.findByRole('button', { name: '500,000 تومان' }));
    fireEvent.click(screen.getByRole('button', { name: t('web.rp_topup_continue') }));
    fireEvent.click(await screen.findByRole('radio', { name: /کارت به کارت/u }));
    fireEvent.click(screen.getByRole('button', { name: t('web.rp_topup_pay') }));
    expect(await screen.findByText('6037 9911 2222 3333')).toBeInTheDocument();
    expect(screen.getByText('REF-123')).toBeInTheDocument();
    expect(screen.getByText('علی رضایی')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t('web.rp_card_sent') }));
    const picker = await screen.findByLabelText(t('web.rp_card_receipt_label'));
    // The receipt is chosen through the Persian FilePicker, never the browser's bare control.
    expect(picker.closest('.file-picker')).not.toBeNull();
    expect(
      screen.getByText(t('web.rp_card_receipt_window').replace('{n}', '30')),
    ).toBeInTheDocument();
    expect(api.calls.find((c) => c.url.endsWith('/wallet/topup'))?.body).toEqual({
      amount: irt('500000'),
      provider: 'MANUAL_TRANSFER',
    });
  });
});

// --- Price list --------------------------------------------------------------------------------

describe('«لیست قیمت»', () => {
  it('draws the tenant’s categories in order with list and own prices and the discount', async () => {
    mount('/r/prices', [{ url: `${API}/prices`, body: prices }]);
    const headings = await screen.findAllByRole('heading', { level: 3 });
    expect(headings.map((h) => h.textContent)).toEqual(['ماهانه', 'دوماهه']);
    expect(screen.getByText('96,000 تومان')).toBeInTheDocument();
    expect(screen.getAllByText('120,000 تومان').length).toBeGreaterThan(0);
  });

  it('«کپی لیست برای مشتری» copies the LIST prices only', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mount('/r/prices', [{ url: `${API}/prices`, body: prices }]);
    await screen.findByText('ماهانه');
    fireEvent.click(screen.getByRole('button', { name: t('web.rp_prices_copy') }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(copied).toContain('120,000 تومان');
    expect(copied).toContain('230,000 تومان');
    // The reseller's own prices and the discount never leave the panel.
    expect(copied).not.toContain('96,000');
    expect(copied).not.toContain('185,000');
    expect(copied).not.toContain('٪');
    expect(copied.indexOf('ماهانه')).toBeLessThan(copied.indexOf('دوماهه'));
  });

  it('the copy text is built from listPrice', () => {
    const text = customerPriceList({
      groups: [
        {
          categoryId: null,
          title: null,
          items: [
            {
              productId: 'x',
              title: 'نامحدود',
              trafficBytes: '0',
              durationDays: 30,
              listPrice: irt('320000'),
              yourPrice: irt('250000'),
              discountPercent: 22,
            },
          ],
        },
      ],
    });
    expect(text).toContain('320,000 تومان');
    expect(text).not.toContain('250,000');
    expect(text).toContain(t('web.rp_prices_other'));
    expect(text).toContain(t('web.rp_unlimited'));
  });
});

// --- Support -----------------------------------------------------------------------------------

describe('«پشتیبانی»', () => {
  const TICKET = {
    id: 't-1',
    code: 'T-1',
    subject: 'قطع شدن سرویس',
    categoryTitle: 'فنی',
    status: 'OPEN',
    lastMessageAt: '2026-11-09T10:00:00.000Z',
  };

  it('lists the reseller’s tickets and opens a thread with a reply box', async () => {
    const api = mount('/r/support', [
      { url: `${API}/tickets`, body: { items: [TICKET] } },
      { url: `${API}/ticket-categories`, body: { items: [{ id: 'c-1', title: 'فنی' }] } },
      {
        url: `${API}/tickets/t-1`,
        body: {
          ...TICKET,
          messages: [
            {
              author: 'CUSTOMER',
              text: 'سلام',
              hasAttachment: false,
              createdAt: '2026-11-09T10:00:00.000Z',
            },
            {
              author: 'SUPPORT',
              text: 'در حال بررسی',
              hasAttachment: true,
              createdAt: '2026-11-09T11:00:00.000Z',
            },
          ],
        },
      },
      {
        url: `${API}/tickets/t-1/replies`,
        method: 'POST',
        body: {
          ...TICKET,
          messages: [
            {
              author: 'CUSTOMER',
              text: 'ممنون',
              hasAttachment: false,
              createdAt: '2026-11-09T12:00:00.000Z',
            },
          ],
        },
      },
    ]);
    fireEvent.click(await screen.findByRole('button', { name: 'قطع شدن سرویس' }));
    expect(await screen.findByText('در حال بررسی')).toBeInTheDocument();
    expect(screen.getByText(t('web.rp_ticket_attachment'))).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(t('web.rp_ticket_reply')), {
      target: { value: 'ممنون' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.rp_ticket_reply_send') }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.url.endsWith('/replies'))?.body).toEqual({ text: 'ممنون' }),
    );
  });

  it('opens a new ticket with a category and a message', async () => {
    const api = mount('/r/support', [
      { url: `${API}/tickets`, body: { items: [] } },
      { url: `${API}/ticket-categories`, body: { items: [{ id: 'c-1', title: 'فنی' }] } },
      {
        url: `${API}/tickets`,
        method: 'POST',
        body: { ...TICKET, messages: [] },
      },
      { url: `${API}/tickets/t-1`, body: { ...TICKET, messages: [] } },
    ]);
    expect(await screen.findByText(t('web.rp_support_empty'))).toBeInTheDocument();
    await screen.findByRole('option', { name: 'فنی' });
    fireEvent.change(screen.getByLabelText(t('web.rp_ticket_message')), {
      target: { value: 'کمک' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.rp_ticket_send') }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({
        categoryId: 'c-1',
        text: 'کمک',
      }),
    );
  });
});

// --- Account and settings -----------------------------------------------------------------------

const SESSIONS = {
  items: [
    {
      id: 'sess-current',
      current: true,
      device: 'Chrome on Windows',
      network: '203.0.113.x',
      createdAt: '2026-11-10T09:00:00.000Z',
      lastSeenAt: '2026-11-10T09:30:00.000Z',
    },
    {
      id: 'sess-other',
      current: false,
      device: 'Safari on iPhone',
      network: null,
      createdAt: '2026-11-01T09:00:00.000Z',
      lastSeenAt: '2026-11-08T09:30:00.000Z',
    },
  ],
};
const PREFS = {
  newDeviceAlert: true,
  expiringDigest: true,
  dailySalesReport: false,
  ticketReply: true,
};
const ACTIVITY = {
  items: [
    {
      id: 'a-1',
      action: 'reseller_web.login',
      entityType: 'reseller_web_session',
      entityId: 's',
      result: 'SUCCESS',
      at: '2026-11-10T09:00:00.000Z',
    },
    {
      id: 'a-2',
      action: 'order.confirm',
      entityType: 'order',
      entityId: 'o',
      result: 'SUCCESS',
      at: '2026-11-09T09:00:00.000Z',
    },
  ],
  nextCursor: null,
};
const settingsRoutes: Route[] = [
  { url: `${API}/settings/notifications`, body: PREFS },
  { url: `${API}/security/sessions`, body: SESSIONS },
  { url: `${API}/security/activity`, body: ACTIVITY },
];

describe('«حساب و تنظیمات»', () => {
  beforeEach(() => visit('/r/settings'));

  it('shows the account card, the notification switches and the recent activity', async () => {
    mount('/r/settings', settingsRoutes);
    expect(await screen.findByText('آرین')).toBeInTheDocument();
    expect(screen.getByText('@arian_store')).toBeInTheDocument();
    expect(
      await screen.findByRole('switch', { name: t('web.rp_notif_new_device') }),
    ).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: t('web.rp_notif_sales') })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(await screen.findByText(t('web.rp_act_login'))).toBeInTheDocument();
    expect(screen.getByText(t('web.rp_act_order_confirm'))).toBeInTheDocument();
  });

  it('a notification switch is a PUT of just that preference', async () => {
    const api = mount('/r/settings', [
      ...settingsRoutes,
      {
        url: `${API}/settings/notifications`,
        method: 'PUT',
        body: { ...PREFS, dailySalesReport: true },
      },
    ]);
    fireEvent.click(await screen.findByRole('switch', { name: t('web.rp_notif_sales') }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'PUT')?.body).toEqual({ dailySalesReport: true }),
    );
  });

  it('enrols 2FA: the key and QR, then the code activates it', async () => {
    const api = mount('/r/settings', [
      ...settingsRoutes,
      {
        url: `${API}/security/totp/enrol`,
        method: 'POST',
        body: {
          secret: 'JBSWY3DPEHPK3PXP',
          otpauthUri: 'otpauth://totp/x',
          qrPngDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
          expiresAt: '2026-11-10T10:10:00.000Z',
          parameters: { algorithm: 'SHA1', digits: 6, periodSeconds: 30 },
        },
      },
      { url: `${API}/security/totp/activate`, method: 'POST', body: { ended: 1 } },
    ]);
    fireEvent.click(await screen.findByRole('button', { name: t('web.rp_2fa_enable') }));
    expect(await screen.findByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(t('web.rp_2fa_label')), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: t('web.rp_2fa_confirm') }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.url.endsWith('/totp/activate'))?.body).toEqual({
        code: '123456',
      }),
    );
  });

  it('says a stale sign-in must be refreshed when enrolling needs a fresher session', async () => {
    mount('/r/settings', [
      ...settingsRoutes,
      problem(`${API}/security/totp/enrol`, 409, 'reseller_web.second_factor_state', {
        reason: 'FRESH_SIGN_IN_REQUIRED',
      }),
    ]);
    fireEvent.click(await screen.findByRole('button', { name: t('web.rp_2fa_enable') }));
    expect(await screen.findByText(t('web.rp_2fa_fresh'))).toBeInTheDocument();
  });

  it('with 2FA on, «خاموش کردن» asks for a code and posts it', async () => {
    const api = mount(
      '/r/settings',
      [
        ...settingsRoutes,
        { url: `${API}/security/totp/disable`, method: 'POST', body: { ok: true } },
      ],
      me({ secondFactor: true }),
    );
    fireEvent.click(await screen.findByRole('button', { name: t('web.rp_2fa_disable') }));
    fireEvent.change(screen.getByLabelText(t('web.rp_2fa_label')), { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: t('web.rp_2fa_disable_confirm') }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.url.endsWith('/totp/disable'))?.body).toEqual({
        code: '654321',
      }),
    );
  });

  it('lists the sessions: this device is marked, another can be signed out one by one', async () => {
    const api = mount('/r/settings', [
      ...settingsRoutes,
      { url: `${API}/security/sessions/sess-other/revoke`, method: 'POST', body: { ok: true } },
    ]);
    expect(await screen.findByText(t('web.rp_session_current'))).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: t('web.rp_session_signout') });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0] as HTMLElement);
    await waitFor(() =>
      expect(api.calls.some((c) => c.url.endsWith('/security/sessions/sess-other/revoke'))).toBe(
        true,
      ),
    );
  });

  it('«خروج از همهٔ دستگاه‌ها» asks first, then signs out everywhere and goes to the login page', async () => {
    const api = mount('/r/settings', [
      ...settingsRoutes,
      { url: `${API}/security/sessions/revoke-all`, method: 'POST', body: { ended: 2 } },
    ]);
    fireEvent.click(await screen.findByRole('button', { name: t('web.rp_sessions_all') }));
    expect(api.calls.some((c) => c.url.endsWith('/revoke-all'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: t('web.rp_sessions_all_confirm') }));
    await waitFor(() => expect(window.location.pathname).toBe('/r/login'));
    expect(api.calls.some((c) => c.url.endsWith('/revoke-all'))).toBe(true);
  });

  it('without an install prompt it shows the iPhone instruction; with one, the install button', async () => {
    mount('/r/settings', settingsRoutes);
    expect(await screen.findByText(t('web.rp_pwa_ios'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('web.rp_pwa_install') })).toBeNull();
    const prompt = vi.fn(() => Promise.resolve());
    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompt,
      userChoice: Promise.resolve({ outcome: 'accepted' as const }),
    });
    act(() => {
      window.dispatchEvent(event);
    });
    const install = await screen.findByRole('button', { name: t('web.rp_pwa_install') });
    fireEvent.click(install);
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(t('web.rp_pwa_ios'))).toBeNull();
  });
});

describe('a service row with a trial flag', () => {
  it('marks a trial service', async () => {
    mount('/r/services', [
      {
        url: `${API}/services`,
        body: {
          items: [serviceRow({ isTrial: true })],
          counts: { ALL: 1, ACTIVE: 1, EXPIRING: 0, EXPIRED: 0, SUSPENDED: 0, OTHER: 0 },
          page: 0,
          pages: 1,
          total: 1,
        },
      },
    ]);
    expect(await screen.findByText(t('web.rp_trial'))).toBeInTheDocument();
  });
});
