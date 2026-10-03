import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { UserDetailPage } from '../../apps/web/src/pages/users';
import { customer, product, renderPage, stubApi } from './harness';

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
    await screen.findByText(
      'قوانین و پذیرش آن هنوز در این نسخه پیاده نشده است؛ داده‌ای برای نمایش وجود ندارد.',
    );
    expect(screen.getAllByText('+989121234567').length).toBeGreaterThan(0);
    // Exact aggregates only: the purchase count in the head, from the server's summary.
    await waitFor(() => expect(within(head).getByText('تعداد خرید')).toBeTruthy());
    expect(within(head).getByText('سرویس‌های فعال')).toBeTruthy();
  });

  it('draws no control and no dangerous operation without their permissions', async () => {
    const api = stubApi(routes());
    renderPage(<UserDetailPage id={ID} {...OFF} denied={false} />);
    await screen.findByText('محدودیت‌ها و کنترل‌ها', { selector: 'h2' });
    expect(screen.queryByRole('button', { name: 'معاف کردن' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'انتقال حساب کاربری' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'افزودن دستی سفارش' })).toBeNull();
    expect(screen.getByText('برای دیدن تاریخچه مدیریتی مجوز audit.view لازم است.')).toBeTruthy();
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
    await screen.findByText('محدودیت‌ها و کنترل‌ها', { selector: 'h2' });
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
