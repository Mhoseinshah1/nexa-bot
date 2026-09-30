import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  CampaignDetailPage,
  CampaignNewPage,
  CampaignsPage,
} from '../../apps/web/src/pages/campaigns';
import { NAV, resolve } from '../../apps/web/src/app';
import { renderPage, stubApi, type Api } from './harness';

/**
 * Round N, C1 on the Web Admin: «کمپین‌ها».
 *
 * Every response goes through the real client and the real zod schemas. What these cases
 * hold is what the screen DOES: say in Persian what a campaign is and is not, confirm with
 * exactly the figures the preview showed (and never without the operator ticking that they
 * reviewed it), ask twice before a cancel, and report only persisted facts.
 */

const CAMPAIGN_ID = '019310ab-cdef-7012-8345-6789abcdef01';
const HASH = 'a'.repeat(64);
const FINGERPRINT = 'b'.repeat(32);
const WALLET_FINGERPRINT = 'c'.repeat(32);

function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CAMPAIGN_ID,
    name: 'جشنواره پاییز',
    description: '',
    state: 'DRAFT',
    startsAt: '2026-10-02T10:30:00.000Z',
    endsAt: '2026-10-12T10:30:00.000Z',
    startLocal: { date: '1405-07-10', time: '14:00' },
    endLocal: { date: '1405-07-20', time: '14:00' },
    audienceConfirmedCount: null,
    actionKinds: ['DISCOUNT', 'WALLET_GIFT'],
    scheduledAt: null,
    startedAt: null,
    pausedAt: null,
    completedAt: null,
    cancelledAt: null,
    createdAt: '2026-09-29T10:00:00.000Z',
    updatedAt: '2026-09-29T10:00:00.000Z',
    ...overrides,
  };
}

function detail(overrides: Record<string, unknown> = {}) {
  return {
    campaign: {
      ...summary(overrides),
      audience: { version: 1 },
      audienceHash: HASH,
      audienceFingerprint: null,
      actions: [
        {
          kind: 'DISCOUNT',
          state: 'PENDING',
          terms: {
            kind: 'AUTOMATIC',
            code: null,
            type: 'PERCENTAGE',
            value: '20',
            currency: null,
            appliesTo: ['NEW_SERVICE'],
            productId: null,
            categoryId: null,
            firstPurchaseOnly: false,
            minimumSubtotalAmount: null,
            totalRedemptionsLimit: null,
            perCustomerLimit: null,
            priority: 0,
            stackable: false,
          },
          ruleStatus: null,
          discountId: null,
          cashbackRuleId: null,
          broadcastId: null,
          bulkOperationId: null,
          failureCode: null,
          launchedAt: null,
        },
        {
          kind: 'WALLET_GIFT',
          state: 'PENDING',
          terms: { amountMinor: '50000', currency: 'IRT', notify: true },
          ruleStatus: null,
          discountId: null,
          cashbackRuleId: null,
          broadcastId: null,
          bulkOperationId: null,
          failureCode: null,
          launchedAt: null,
        },
      ],
      ...overrides,
    },
    presentation: { timezone: 'Asia/Tehran', calendar: 'jalali' },
  };
}

const preview = {
  audience: {
    asOf: '2026-09-29T10:00:00.000Z',
    definition: { version: 1 },
    definitionHash: HASH,
    customers: 3,
    reachable: 2,
    fingerprint: FINGERPRINT,
    sample: [{ id: 'x', firstName: 'زهرا', username: null, telegramUserId: '930001' }],
  },
  discountMaxLiability: null,
  walletGift: {
    count: 3,
    customers: 3,
    fingerprint: WALLET_FINGERPRINT,
    totalLiability: { amountMinor: '150000', currency: 'IRT' },
  },
  trafficGift: null,
  timeGift: null,
  typedCountRequired: { audience: false, walletGift: true, trafficGift: false, timeGift: false },
};

const posts = (api: Api, path: string) =>
  api.calls.filter((call) => call.method === 'POST' && call.url.includes(path));

describe('the campaigns list', () => {
  it('names each state and action in Persian, never as an internal key', async () => {
    stubApi([
      {
        url: '/campaigns',
        body: {
          campaigns: [summary({ state: 'SCHEDULED', audienceConfirmedCount: 1200 })],
          nextCursor: null,
          presentation: { timezone: 'Asia/Tehran', calendar: 'jalali' },
        },
      },
    ]);
    renderPage(
      <CampaignsPage
        route={{ path: '/campaigns', query: new URLSearchParams() }}
        denied={false}
        mayManage
      />,
    );
    const table = await screen.findByRole('table', { name: 'کمپین‌ها' });
    const row = within(table).getByText('جشنواره پاییز').closest('tr') as HTMLElement;
    expect(within(row).getByText('زمان‌بندی‌شده')).toBeInTheDocument();
    expect(row.textContent).toContain('تخفیف');
    expect(row.textContent).toContain('هدیهٔ کیف پول');
    expect(row.textContent).toContain('1405/07/10 14:00');
    expect(row.textContent).toContain('1,200');
    expect(row.textContent).not.toContain('WALLET_GIFT');
    expect(row.textContent).not.toContain('SCHEDULED');
    // What a campaign does NOT do is said before anything else.
    expect(screen.getByText(/نه فقط برای مخاطبان/)).toBeInTheDocument();
  });

  it('is reachable from the navigation under its own view key', () => {
    const entry = NAV.find((item) => item.id === 'campaigns');
    expect(entry?.path).toBe('/campaigns');
    expect(entry?.permission).toBe('campaigns.view');
    expect(
      resolve({ path: '/campaigns', query: new URLSearchParams() }, ['campaigns.view']).title,
    ).toBe('کمپین‌ها');
  });
});

describe('a new campaign', () => {
  it('edits its audience with the SHARED builder and sends the definition as it stands', async () => {
    const api = stubApi([
      {
        url: '/audience/options',
        body: { currency: 'IRT', resellerTiers: [], products: [], panels: [] },
      },
      { url: '/products', body: { products: [], nextCursor: null } },
      { url: '/product-categories', body: { categories: [] } },
      { url: '/campaigns', body: detail() },
    ]);
    renderPage(<CampaignNewPage denied={false} mayManage />);
    // Broadcast's own builder, not a second one.
    expect(await screen.findByText('چه کسانی')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('کاربران عادی (غیر نماینده)'));

    const inputs = screen.getAllByRole('textbox');
    fireEvent.change(inputs[0] as HTMLElement, { target: { value: 'جشنواره پاییز' } });
    fireEvent.change(screen.getByPlaceholderText('1405-07-10'), {
      target: { value: '1405-07-10' },
    });
    fireEvent.change(screen.getByPlaceholderText('1405-07-20'), {
      target: { value: '1405-07-20' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ذخیرهٔ پیش‌نویس' }));

    await waitFor(() => expect(posts(api, '/campaigns')).toHaveLength(1));
    const body = posts(api, '/campaigns')[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      name: 'جشنواره پاییز',
      start: { date: '1405-07-10', time: '10:00' },
      end: { date: '1405-07-20', time: '10:00' },
      audience: { version: 1, segment: { ordinary: true, resellerTierIds: [] } },
      actions: {},
    });
  });
});

describe('one campaign', () => {
  it('confirms with exactly the figures the preview showed, only once reviewed', async () => {
    const api = stubApi([
      { url: `/campaigns/${CAMPAIGN_ID}/preview`, body: preview },
      { url: `/campaigns/${CAMPAIGN_ID}/schedule`, body: detail({ state: 'SCHEDULED' }) },
      { url: `/campaigns/${CAMPAIGN_ID}`, body: detail() },
    ]);
    renderPage(<CampaignDetailPage id={CAMPAIGN_ID} denied={false} mayManage />);

    // The exact liability is on screen before anything can be confirmed.
    await screen.findByText('تعهد مالی کل هدیهٔ کیف پول');
    expect(screen.getByText('150,000')).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'تأیید و زمان‌بندی' });
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByLabelText('برای تأیید، تعداد را تایپ کنید'), {
      target: { value: '3' },
    });
    fireEvent.click(screen.getByLabelText(/پیش‌نمایش را بررسی کردم/));
    fireEvent.click(confirm);

    await waitFor(() => expect(posts(api, '/schedule')).toHaveLength(1));
    const body = posts(api, '/schedule')[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      expectedDefinitionHash: HASH,
      expectedRecipients: 3,
      expectedFingerprint: FINGERPRINT,
      walletGift: {
        count: 3,
        fingerprint: WALLET_FINGERPRINT,
        typedCount: 3,
        totalMinor: '150000',
      },
      trafficGift: null,
      timeGift: null,
      confirmed: true,
    });
  });

  it('starts the confirmation over when the preview comes back different', async () => {
    const previewRoute = { url: `/campaigns/${CAMPAIGN_ID}/preview`, body: preview as unknown };
    stubApi([
      previewRoute,
      {
        url: `/campaigns/${CAMPAIGN_ID}/schedule`,
        status: 409,
        body: {
          error: {
            kind: 'conflict',
            code: 'audience.changed',
            message: 'moved',
            correlationId: 'test',
          },
        },
      },
      { url: `/campaigns/${CAMPAIGN_ID}`, body: detail() },
    ]);
    renderPage(<CampaignDetailPage id={CAMPAIGN_ID} denied={false} mayManage />);
    await screen.findByText('تعهد مالی کل هدیهٔ کیف پول');
    const typedBox = () =>
      screen.getByLabelText('برای تأیید، تعداد را تایپ کنید') as HTMLInputElement;
    const reviewedBox = () => screen.getByLabelText(/پیش‌نمایش را بررسی کردم/) as HTMLInputElement;
    fireEvent.change(typedBox(), { target: { value: '3' } });
    fireEvent.click(reviewedBox());
    expect(reviewedBox().checked).toBe(true);

    // The server refuses (the audience moved) and the refetched preview is a new set.
    previewRoute.body = {
      ...preview,
      audience: { ...preview.audience, customers: 4, fingerprint: 'd'.repeat(32) },
      walletGift: {
        ...preview.walletGift,
        count: 4,
        customers: 4,
        fingerprint: 'e'.repeat(32),
        totalLiability: { amountMinor: '200000', currency: 'IRT' },
      },
    };
    fireEvent.click(screen.getByRole('button', { name: 'تأیید و زمان‌بندی' }));
    await screen.findByText('200,000');
    // The tick and the typed count were for the old figures: both start over.
    expect(reviewedBox().checked).toBe(false);
    expect(typedBox().value).toBe('');
    expect(screen.getByRole('button', { name: 'تأیید و زمان‌بندی' })).toBeDisabled();
  });

  it('asks before a cancel, and says a cancel undoes nothing already done', async () => {
    const api = stubApi([
      { url: `/campaigns/${CAMPAIGN_ID}/results`, body: results() },
      { url: `/campaigns/${CAMPAIGN_ID}/cancel`, body: detail({ state: 'CANCELLED' }) },
      { url: `/campaigns/${CAMPAIGN_ID}`, body: detail({ state: 'ACTIVE' }) },
    ]);
    renderPage(<CampaignDetailPage id={CAMPAIGN_ID} denied={false} mayManage />);
    fireEvent.click(await screen.findByRole('button', { name: 'لغو کمپین' }));
    expect(posts(api, '/cancel')).toHaveLength(0);
    expect(screen.getByText(/برگردانده نمی‌شود/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'بله، لغو شود' }));
    await waitFor(() => expect(posts(api, '/cancel')).toHaveLength(1));
  });

  it('reports persisted facts only, with no revenue attributed to the campaign', async () => {
    stubApi([
      { url: `/campaigns/${CAMPAIGN_ID}/results`, body: results() },
      { url: `/campaigns/${CAMPAIGN_ID}`, body: detail({ state: 'ACTIVE' }) },
    ]);
    renderPage(<CampaignDetailPage id={CAMPAIGN_ID} denied={false} mayManage={false} />);
    const card = (await screen.findByText('نتایج')).closest('section') as HTMLElement;
    await waitFor(() => expect(card.textContent).toContain('سفارش‌های دارای تخفیف کمپین'));
    expect(card.textContent).toContain('پرداخت‌شده');
    expect(card.textContent).toContain('40,000');
    expect(card.textContent).toContain('مبلغ واریزشده');
    expect(card.textContent).not.toMatch(/درآمد کمپین|نرخ تبدیل/);
    // Cashback in two currencies is two lines, never one added-up figure.
    expect(card.textContent).toContain('جمع کش‌بک به تفکیک ارز');
    expect(card.textContent).toContain('8,000');
    expect(card.textContent).not.toContain('9,200');
    // Without campaigns.manage there is nothing to press.
    expect(screen.queryByRole('button', { name: 'لغو کمپین' })).toBeNull();
  });
});

function results() {
  const bulk = {
    total: 3,
    pending: 0,
    credited: 3,
    planned: 0,
    awaitingReconciliation: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    notified: 3,
  };
  return {
    targeted: 3,
    discountRedemptions: [
      { state: 'PAID', count: 2, amount: { amountMinor: '40000', currency: 'IRT' } },
    ],
    cashback: {
      byState: [
        { state: 'EARNED', count: 1, amount: { amountMinor: '8000', currency: 'IRT' } },
        { state: 'PENDING', count: 1, amount: { amountMinor: '1200', currency: 'USD' } },
      ],
      totals: [
        {
          currency: 'IRT',
          earned: { amountMinor: '8000', currency: 'IRT' },
          reversedRecovered: { amountMinor: '0', currency: 'IRT' },
          reversedUnrecovered: { amountMinor: '0', currency: 'IRT' },
        },
        {
          currency: 'USD',
          earned: { amountMinor: '1200', currency: 'USD' },
          reversedRecovered: { amountMinor: '0', currency: 'USD' },
          reversedUnrecovered: { amountMinor: '0', currency: 'USD' },
        },
      ],
    },
    announcement: null,
    walletGift: { counts: bulk, creditedTotal: { amountMinor: '150000', currency: 'IRT' } },
    trafficGift: null,
    timeGift: null,
  };
}
