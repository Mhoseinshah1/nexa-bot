import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { COMMERCE_ERROR_CODES } from '@nexa/contracts';
import { UserDetailPage } from '../../apps/web/src/pages/users';
import {
  TOGGLE_REFUSAL_LABELS,
  parsePersonalDiscountPercent,
} from '../../apps/web/src/pages/customer-360-sections';
import { customer, product, renderPage, stubApi } from './harness';
import { openC360Tab } from './c360-helpers';
import { t, type WebKey } from '../../apps/web/src/i18n/web.fa';

/**
 * Customer 360 (spec §11) — the redesigned customer page, rendered against the shapes the
 * server returns: every fixture below goes through the real API client and is parsed by the
 * contract's schema.
 *
 * What is asserted is what the owner asked for: the Telegram numeric id as the identity,
 * terms shown honestly as unavailable, controls drawn only under their own permission and
 * sent with a reason and an idempotency key, the account transfer refusing to confirm a
 * blocked preview and binding its confirmation to the preview's fingerprint, and the
 * dangerous operations kept apart.
 */

const ID = '019210ab-cdef-7012-8345-6789abcdef01';
const OFF = {
  mayBlock: false,
  mayViewWallet: false,
  mayCredit: false,
  mayDebit: false,
  mayViewOrders: false,
  mayViewServices: false,
  mayEditTrial: false,
  mayViewReferrals: false,
  mayViewReseller: false,
  mayEditReseller: false,
} as const;

const overview = (overrides: Record<string, unknown> = {}) => ({
  overview: {
    customerId: ID,
    channelMembershipExemptAt: null,
    phone: null,
    locationOverride: null,
    marketingOptOutAt: null,
    personalDiscount: { percent: 0, setAt: null, enabled: false },
    terms: { available: false },
    ...overrides,
  },
});

const summary = {
  summary: {
    orders: {
      purchases: [{ currency: 'IRT', count: 3, amount: '750000' }],
      discounts: [{ currency: 'IRT', count: 3, amount: '50000' }],
      refunded: [],
      awaitingPayment: 1,
      orderCount: 5,
    },
    payments: {
      confirmed: [{ currency: 'IRT', count: 3, amount: '750000' }],
      pending: 0,
      paymentCount: 3,
    },
    ledger: [
      {
        reason: 'CASHBACK_PURCHASE',
        direction: 'CREDIT',
        currency: 'IRT',
        count: 1,
        amount: '7500',
      },
    ],
    services: { byState: [{ state: 'ACTIVE', count: 2 }], serviceCount: 2 },
    denied: [],
  },
};

const routes = (
  extra: readonly { url: string; body: unknown; status?: number }[] = [],
  ov = overview(),
) => [
  { url: `/users/${ID}`, body: { customer: customer() } },
  { url: `/users/${ID}/overview`, body: ov },
  { url: `/users/${ID}/financial-summary`, body: summary },
  { url: `/users/${ID}/trial`, body: { trial: trialBody } },
  ...extra,
];

const trialBody = {
  customerId: ID,
  featureEnabled: true,
  globalLimit: 1,
  override: null,
  effectiveLimit: 1,
  used: 0,
  remaining: 1,
};

describe('Customer 360 — the customer page', () => {
  it('names the customer by the Telegram numeric id and says terms are not available, not "not accepted"', async () => {
    stubApi(
      routes(
        [],
        overview({ phone: { number: '+989121234567', verifiedAt: '2026-09-01T00:00:00.000Z' } }),
      ),
    );
    const { container } = renderPage(<UserDetailPage id={ID} {...OFF} denied={false} />);
    const head = await waitFor(() => {
      const found = container.querySelector('.detail-head');
      if (found === null) throw new Error('no head yet');
      return found as HTMLElement;
    });
    expect(within(head).getByText('5551234567')).toBeTruthy();
    // The internal uuid is never the operator's identity on the page head.
    expect(head.textContent ?? '').not.toContain(ID);
    expect((await screen.findAllByText('+989121234567')).length).toBeGreaterThan(0);
    // W5: a server without the terms domain shows a dash, never a «not built» note.
    expect(screen.queryByText(/در این نسخه پیاده نشده/)).toBeNull();
    // Exact aggregates only: the purchase count, from the server's summary — in the stat strip
    // AFTER the operations panel (demo parity), never inside the identity head.
    const strip = container.querySelector('.c360-stats') as HTMLElement;
    await waitFor(() => expect(within(strip).getByText('تعداد خرید')).toBeTruthy());
    expect(within(strip).getByText('سرویس‌های فعال')).toBeTruthy();
    expect(within(head).queryByText('تعداد خرید')).toBeNull();
    const panel = container.querySelector('.action-panel, [data-action-panel]');
    if (panel !== null) {
      // DOCUMENT_POSITION_FOLLOWING: the strip comes after the panel.
      expect(panel.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('draws no control and no dangerous operation without their permissions', async () => {
    const api = stubApi(routes());
    renderPage(<UserDetailPage id={ID} {...OFF} denied={false} />);
    await openC360Tab('controls');
    await screen.findByText('محدودیت‌ها و کنترل‌ها', { selector: 'h2' });
    expect(screen.queryByRole('button', { name: 'معاف کردن' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'انتقال حساب کاربری' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'افزودن دستی سفارش' })).toBeNull();
    await openC360Tab('timeline');
    expect(
      await screen.findByText('برای دیدن تاریخچه مدیریتی مجوز audit.view لازم است.'),
    ).toBeTruthy();
    expect(api.calls.some((call) => call.url.includes('/timeline'))).toBe(false);
  });

  it('exempts from channel membership only with a reason, sending an idempotency key', async () => {
    const api = stubApi(
      routes([
        {
          url: `/users/${ID}/channel-exemption`,
          body: {
            ...overview({ channelMembershipExemptAt: '2026-10-02T10:00:00.000Z' }),
            changed: true,
          },
        },
      ]),
    );
    renderPage(<UserDetailPage id={ID} {...OFF} mayExemptChannel denied={false} />);
    await openC360Tab('controls');
    fireEvent.click(await screen.findByRole('button', { name: 'معاف کردن' }));
    const confirm = screen.getByRole('button', { name: 'تأیید' });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('دلیل (اجباری)'), { target: { value: 'VIP' } });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.includes('/channel-exemption'))).toBe(true),
    );
    const sent = api.calls.find((call) => call.url.includes('/channel-exemption'));
    expect(sent?.method).toBe('POST');
    expect(sent?.body).toMatchObject({ exempt: true, reason: 'VIP' });
    expect(typeof (sent?.body as { idempotencyKey?: unknown }).idempotencyKey).toBe('string');
    // The page now shows the stored state the server answered with.
    expect((await screen.findAllByText('معاف از عضویت')).length).toBeGreaterThan(0);
  });

  it('R10 D3: sets a personal discount — a whole percent 0..100 and a reason, Persian errors', async () => {
    const api = stubApi(
      routes([
        {
          url: `/users/${ID}/personal-discount`,
          body: {
            ...overview({
              personalDiscount: { percent: 25, setAt: '2026-10-26T10:00:00.000Z', enabled: true },
            }),
            changed: true,
          },
        },
      ]),
    );
    renderPage(<UserDetailPage id={ID} {...OFF} mayEditPersonalDiscount denied={false} />);
    await openC360Tab('controls');
    expect(await screen.findByText('تخفیف شخصی')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'تعیین درصد' }));
    const confirm = screen.getByRole('button', { name: 'تأیید' });
    fireEvent.change(screen.getByLabelText('دلیل (اجباری)'), { target: { value: 'وفادار' } });
    const percent = screen.getByLabelText('درصد تخفیف شخصی (0 تا 100)');
    // Out of range: the Persian sentence, and nothing can be sent.
    fireEvent.change(percent, { target: { value: '۱۵۰' } });
    expect(screen.getByText('درصد باید یک عدد صحیح از 0 تا 100 باشد.')).toBeTruthy();
    expect(confirm).toBeDisabled();
    // Persian digits are read as the number they are.
    fireEvent.change(percent, { target: { value: '۲۵' } });
    expect(screen.queryByText('درصد باید یک عدد صحیح از 0 تا 100 باشد.')).toBeNull();
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.includes('/personal-discount'))).toBe(true),
    );
    const sent = api.calls.find((call) => call.url.includes('/personal-discount'));
    expect(sent?.method).toBe('POST');
    expect(sent?.body).toMatchObject({ percent: 25, reason: 'وفادار' });
    expect(typeof (sent?.body as { idempotencyKey?: unknown }).idempotencyKey).toBe('string');
  });

  it('R10 D3: draws no personal-discount control without users.discount.edit, and says when the feature is off', async () => {
    stubApi(
      routes([], overview({ personalDiscount: { percent: 15, setAt: null, enabled: false } })),
    );
    renderPage(<UserDetailPage id={ID} {...OFF} denied={false} />);
    await openC360Tab('controls');
    expect(await screen.findByText('تخفیف شخصی')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'تعیین درصد' })).toBeNull();
    expect(
      screen.getByText(
        'قابلیت «تخفیف شخصی مشتری» خاموش است؛ این درصد فعلاً روی هیچ سفارشی اعمال نمی‌شود',
      ),
    ).toBeTruthy();
  });

  it('R10 D3: reads a typed percent as a whole number from 0 to 100, or nothing', () => {
    expect(parsePersonalDiscountPercent('0')).toBe(0);
    expect(parsePersonalDiscountPercent(' 100 ')).toBe(100);
    expect(parsePersonalDiscountPercent('۳۵')).toBe(35);
    expect(parsePersonalDiscountPercent('٤٠')).toBe(40);
    for (const bad of ['', '101', '-5', '12.5', 'ده', '1e2']) {
      expect(parsePersonalDiscountPercent(bad), bad).toBeNull();
    }
  });

  it('refuses to confirm a transfer whose preview has blockers, and lists them', async () => {
    const api = stubApi(
      routes([
        {
          url: `/users/${ID}/transfer/preview`,
          body: {
            preview: {
              source: {
                id: ID,
                telegramUserId: '5551234567',
                username: null,
                firstName: null,
                lastName: null,
                status: 'ACTIVE',
              },
              destination: null,
              moves: { services: [], walletAmount: '0', currency: 'IRT' },
              stays: {
                closedServices: 0,
                trialServices: 0,
                orders: 0,
                payments: 0,
                referredCustomers: 0,
                referredBy: false,
                openTickets: 0,
                trialOverride: false,
                locationOverride: false,
                channelExemption: false,
                verifiedPhone: false,
              },
              blockers: ['DESTINATION_UNKNOWN', 'NOTHING_TO_MOVE'],
              warnings: [],
              fingerprint: 'a'.repeat(64),
            },
          },
        },
      ]),
    );
    renderPage(<UserDetailPage id={ID} {...OFF} mayTransfer denied={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'انتقال حساب کاربری' }));
    fireEvent.change(screen.getByLabelText('آی‌دی عددی تلگرام مقصد'), { target: { value: '999' } });
    fireEvent.click(screen.getByRole('button', { name: 'پیش‌نمایش انتقال' }));
    await screen.findByText('مشتری با این آی‌دی عددی در این ربات وجود ندارد.');
    expect(screen.getByText('سرویس یا موجودی قابل انتقالی وجود ندارد.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'انتقال قطعی' })).toBeDisabled();
    // No way to confirm at all: the typed confirmation is not even offered.
    expect(screen.queryByLabelText('برای تأیید، آی‌دی عددی مقصد را دوباره بنویسید')).toBeNull();
    expect(api.calls.some((call) => call.url.endsWith(`/users/${ID}/transfer`))).toBe(false);
  });

  it('binds the transfer to the preview fingerprint and the retyped destination id', async () => {
    const fingerprint = 'b'.repeat(64);
    const api = stubApi(
      routes([
        {
          url: `/users/${ID}/transfer/preview`,
          body: {
            preview: {
              source: {
                id: ID,
                telegramUserId: '5551234567',
                username: null,
                firstName: null,
                lastName: null,
                status: 'ACTIVE',
              },
              destination: {
                id: '019210ab-cdef-7012-8345-6789abcdef02',
                telegramUserId: '777',
                username: null,
                firstName: 'مقصد',
                lastName: null,
                status: 'ACTIVE',
              },
              moves: {
                services: [
                  { id: 's1', providerUsername: 'nx_abc', state: 'ACTIVE', expiresAt: null },
                ],
                walletAmount: '5000',
                currency: 'IRT',
              },
              stays: {
                closedServices: 1,
                trialServices: 1,
                orders: 2,
                payments: 2,
                referredCustomers: 0,
                referredBy: false,
                openTickets: 0,
                trialOverride: false,
                locationOverride: false,
                channelExemption: false,
                verifiedPhone: false,
              },
              blockers: [],
              warnings: ['TRIAL_SERVICES_STAY'],
              fingerprint,
            },
          },
        },
        {
          url: `/users/${ID}/transfer`,
          body: {
            transfer: {
              transferId: 't1',
              fromCustomerId: ID,
              toCustomerId: '019210ab-cdef-7012-8345-6789abcdef02',
              servicesMoved: 1,
              walletMovedAmount: '5000',
              currency: 'IRT',
              createdAt: '2026-10-02T10:00:00.000Z',
              replayed: false,
            },
          },
        },
      ]),
    );
    renderPage(<UserDetailPage id={ID} {...OFF} mayTransfer denied={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'انتقال حساب کاربری' }));
    fireEvent.change(screen.getByLabelText('آی‌دی عددی تلگرام مقصد'), { target: { value: '777' } });
    fireEvent.click(screen.getByRole('button', { name: 'پیش‌نمایش انتقال' }));
    await screen.findByText('سرویس‌های آزمایشی منتقل نمی‌شوند.');
    const go = screen.getByRole('button', { name: 'انتقال قطعی' });
    expect(go).toBeDisabled();
    fireEvent.change(screen.getByLabelText('برای تأیید، آی‌دی عددی مقصد را دوباره بنویسید'), {
      target: { value: '777' },
    });
    fireEvent.change(screen.getByLabelText('دلیل (اجباری)'), { target: { value: 'lost account' } });
    fireEvent.click(go);
    await screen.findByText('انتقال حساب انجام شد.', { exact: false });
    const sent = api.calls.find((call) => call.url.endsWith(`/users/${ID}/transfer`));
    expect(sent?.body).toMatchObject({
      destinationTelegramUserId: '777',
      fingerprint,
      confirmTelegramUserId: '777',
      reason: 'lost account',
    });
  });

  it('lists the management timeline in Persian with the reason, when audit.view is held', async () => {
    stubApi(
      routes([
        {
          url: `/users/${ID}/timeline`,
          body: {
            entries: [
              {
                id: 'a1',
                action: 'customer.channel_exemption.grant',
                actorType: 'WEB_ADMIN',
                actorLabel: 'owner',
                surface: 'WEB',
                result: 'SUCCESS',
                occurredAt: '2026-10-02T10:00:00.000Z',
                reason: 'VIP',
                before: null,
                after: null,
              },
            ],
          },
        },
      ]),
    );
    renderPage(<UserDetailPage id={ID} {...OFF} mayViewAudit denied={false} />);
    await openC360Tab('timeline');
    await screen.findByText('معافیت از عضویت کانال');
    expect(screen.getByText('owner — VIP')).toBeTruthy();
  });

  it('offers a manual order only with the wallet-debit key too, and lists every product page', async () => {
    stubApi(
      routes([
        {
          url: '/products',
          body: { products: [product({ title: 'پلن اول' })], nextCursor: 'p2' },
        },
        {
          url: 'limit=100&cursor=p2',
          body: {
            products: [product({ id: '019220ab-cdef-7012-8345-6789abcdef09', title: 'پلن دوم' })],
            nextCursor: null,
          },
        },
      ]),
    );
    const { unmount } = renderPage(
      <UserDetailPage id={ID} {...OFF} mayManualOrder denied={false} />,
    );
    await screen.findByRole('tablist');
    // orders.manual.create without users.wallet.debit: a guaranteed refusal, so no button.
    expect(screen.queryByRole('button', { name: 'افزودن دستی سفارش' })).toBeNull();
    unmount();

    renderPage(<UserDetailPage id={ID} {...OFF} mayManualOrder mayDebit denied={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'افزودن دستی سفارش' }));
    // The second page's product is offered too.
    expect(await screen.findByRole('option', { name: 'پلن دوم' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'پلن اول' })).toBeTruthy();
  });

  it("links the head's order list by the unified search, ?q=<customerId>", async () => {
    stubApi(routes());
    const { container } = renderPage(
      <UserDetailPage id={ID} {...OFF} mayViewOrders denied={false} />,
    );
    const link = await screen.findByRole('link', { name: 'مشاهده سفارش‌ها' });
    expect(link.getAttribute('href')).toBe(`/orders?q=${ID}`);
    expect(container).toBeTruthy();
  });
});

/**
 * The demo's Customer 360 (W1.5, W2, W3): one action panel with its four groups, nine
 * real tabs drawing only the chosen one, another customer opening on «نمای کلی», and the
 * trial override's writes as dialogs.
 */
describe('Customer 360 — tabs and the action panel', () => {
  const OTHER = '019210ab-cdef-7012-8345-6789abcdef02';

  it('draws only the chosen tab, and opens another customer on «نمای کلی»', async () => {
    stubApi([
      ...routes([{ url: `/users/${ID}/timeline`, body: { entries: [] } }]),
      { url: `/users/${OTHER}`, body: { customer: customer({ id: OTHER }) } },
      { url: `/users/${OTHER}/overview`, body: overview() },
      { url: `/users/${OTHER}/financial-summary`, body: summary },
      { url: `/users/${OTHER}/trial`, body: { trial: trialBody } },
    ]);
    const view = renderPage(<UserDetailPage id={ID} {...OFF} denied={false} />);
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'نمای کلی',
      'سرویس‌ها و سفارش‌ها',
      'پشتیبانی',
      'مالی',
      'محدودیت‌ها و کنترل‌ها',
      'معرف و نماینده',
      'یادداشت‌ها و برچسب‌ها',
      'تاریخچهٔ مدیریتی',
    ]);
    expect(screen.queryByText('محدودیت‌ها و کنترل‌ها', { selector: 'h2' })).toBeNull();
    await openC360Tab('controls');
    expect(
      await screen.findByText('محدودیت‌ها و کنترل‌ها', { selector: 'h2' }),
    ).toBeInTheDocument();
    view.rerender(<UserDetailPage id={OTHER} {...OFF} denied={false} />);
    expect(
      await screen.findByRole('tab', { name: 'نمای کلی', selected: true }),
    ).toBeInTheDocument();
    expect(screen.queryByText('محدودیت‌ها و کنترل‌ها', { selector: 'h2' })).toBeNull();
  });

  it('groups the actions under «عملیات روی این مشتری», the sensitive ones in their strip', async () => {
    stubApi(routes());
    renderPage(
      <UserDetailPage
        id={ID}
        {...OFF}
        mayBlock
        mayViewWallet
        mayCredit
        mayDebit
        mayManualOrder
        mayMessage
        mayTransfer
        mayEditServices
        mayViewServices
        denied={false}
      />,
    );
    const panel = await screen.findByRole('region', { name: 'عملیات روی این مشتری' });
    const group = (name: string) => within(panel).getByRole('group', { name });
    expect(within(group('کیف پول')).getByRole('button', { name: 'افزایش موجودی' })).toBeTruthy();
    expect(within(group('کیف پول')).getByRole('button', { name: 'کسر موجودی' })).toBeTruthy();
    expect(
      within(group('سفارش‌ها')).getByRole('button', { name: 'افزودن دستی سفارش' }),
    ).toBeTruthy();
    expect(
      within(group('ارتباط و دسترسی')).getByRole('button', { name: 'ارسال پیام' }),
    ).toBeTruthy();
    expect(
      within(group('ارتباط و دسترسی')).getByRole('button', { name: 'مسدود کردن' }),
    ).toBeTruthy();
    expect(
      within(group('عملیات حساس')).getByRole('button', { name: 'انتقال حساب کاربری' }),
    ).toBeTruthy();
    // «افزایش موجودی» opens the wallet dialog directly — no scroll, no tab change needed.
    fireEvent.click(within(group('کیف پول')).getByRole('button', { name: 'افزایش موجودی' }));
    expect(screen.getByRole('dialog', { name: 'واریز به کیف پول' })).toBeInTheDocument();
  });

  it('sets a trial override through a dialog, asking before a typed limit is dropped', async () => {
    const api = stubApi(
      routes([{ url: `/users/${ID}/trial/override`, body: { trial: trialBody } }]),
    );
    renderPage(<UserDetailPage id={ID} {...OFF} mayEditTrial denied={false} />);
    await openC360Tab('controls');
    expect(screen.queryByLabelText('سقف اختصاصی')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'ثبت سقف اختصاصی' }));
    const dialog = screen.getByRole('dialog', { name: 'ثبت سقف اختصاصی' });
    const limit = within(dialog).getAllByRole('textbox')[0] as HTMLInputElement;
    fireEvent.change(limit, { target: { value: '3' } });
    fireEvent.click(within(dialog).getByRole('button', { name: t('web.close') }));
    const ask = screen.getByRole('alertdialog');
    fireEvent.click(within(ask).getByRole('button', { name: t('web.unsaved_stay') }));
    expect(limit.value).toBe('3');
    fireEvent.click(within(dialog).getByRole('button', { name: t('web.trial_override_set') }));
    await waitFor(() =>
      expect(api.calls.some((call) => call.method !== 'GET' && call.url.includes('/trial'))).toBe(
        true,
      ),
    );
  });
});

describe('Customer 360 — machine keys read in Persian (W5)', () => {
  it('names every refusal a suspend-all / resume-all item can carry', () => {
    for (const code of [
      COMMERCE_ERROR_CODES.SERVICE_ACTION_NOT_ALLOWED,
      COMMERCE_ERROR_CODES.SERVICE_ACTION_IN_PROGRESS,
      COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE,
      COMMERCE_ERROR_CODES.ORDER_STATE_INVALID,
    ]) {
      const label = TOGGLE_REFUSAL_LABELS[code];
      expect(label, code).toBeDefined();
      expect(t(label as WebKey), code).toMatch(/[؀-ۿ]/u);
    }
  });
});
