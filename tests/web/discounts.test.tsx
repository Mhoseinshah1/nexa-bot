import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { DiscountsPage } from '../../apps/web/src/pages/discounts';
import { OrderDetailPage } from '../../apps/web/src/pages/orders';
import { PLANNED_SURFACES } from '../../apps/web/src/pages/planned';
import { NAV, navPermitted, resolve } from '../../apps/web/src/app';
import { order, renderPage, stubApi, type Api } from './harness';

/**
 * WP8 on the Web Admin: discount rules, cashback rules, the price preview and an order's
 * pricing.
 *
 * Every response goes through the real client and the real zod schema, so a fixture
 * that drifts from `discountSummarySchema` or `orderPricingResponseSchema` fails here
 * rather than in production. What these cases hold is what the screen DOES with the
 * server's figures: send the body the contract declares with a key, send a discount's
 * STORED kind and code back on an edit, name the permission it lacks rather than draw a
 * control, and show the cashback the server recorded — `unrecoveredAmount` included.
 */

const CODE_ID = '019250ab-cdef-7012-8345-6789abcdef01';
const AUTO_ID = '019250ab-cdef-7012-8345-6789abcdef02';
const CASHBACK_ID = '019260ab-cdef-7012-8345-6789abcdef01';
const PRODUCT_ID = '019220ab-cdef-7012-8345-6789abcdef01';
const ORDER_ID = '019230ab-cdef-7012-8345-6789abcdef01';

function discount(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CODE_ID,
    kind: 'CODE',
    code: 'SUMMER25',
    label: 'Summer launch',
    type: 'PERCENTAGE',
    value: '25',
    currency: null,
    appliesTo: ['NEW_SERVICE', 'RENEW'],
    productId: null,
    categoryId: null,
    customerId: null,
    firstPurchaseOnly: false,
    minimumSubtotalAmount: null,
    // Seconds on purpose: an edit that touches nothing else must send these back as
    // they are, not rounded to the minute a `datetime-local` input can hold.
    startsAt: '2026-10-01T08:30:15.000Z',
    endsAt: null,
    totalRedemptionsLimit: 100,
    perCustomerLimit: 1,
    priority: 50,
    stackable: false,
    status: 'INACTIVE',
    liveRedemptions: 37,
    createdAt: '2026-09-01T08:00:00.000Z',
    updatedAt: '2026-09-02T08:00:00.000Z',
    ...overrides,
  };
}

function cashbackRule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CASHBACK_ID,
    label: 'Loyalty five',
    percent: 5,
    appliesTo: ['NEW_SERVICE'],
    productId: null,
    categoryId: null,
    startsAt: null,
    endsAt: null,
    status: 'ACTIVE',
    createdAt: '2026-09-01T08:00:00.000Z',
    updatedAt: '2026-09-02T08:00:00.000Z',
    ...overrides,
  };
}

const lists = (
  discounts: readonly Record<string, unknown>[] = [
    discount(),
    discount({
      id: AUTO_ID,
      kind: 'AUTOMATIC',
      code: null,
      label: 'Autumn automatic',
      type: 'FIXED_AMOUNT',
      value: '20000',
      currency: 'IRT',
      appliesTo: ['ADD_TRAFFIC'],
      startsAt: null,
      totalRedemptionsLimit: null,
      perCustomerLimit: null,
      stackable: true,
      status: 'ACTIVE',
      liveRedemptions: 0,
    }),
  ],
  nextCursor: string | null = null,
) => [
  { url: '/discounts', body: { discounts, nextCursor } },
  { url: '/cashback-rules', body: { rules: [cashbackRule()], nextCursor: null } },
];

const render = (props: Partial<Parameters<typeof DiscountsPage>[0]> = {}) =>
  renderPage(<DiscountsPage denied={false} mayEditDiscounts mayEditCashback {...props} />);

const input = (id: string): HTMLInputElement => {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`no element #${id}`);
  return found as HTMLInputElement;
};

const posts = (api: Api, suffix: string) =>
  api.calls.filter((call) => call.method === 'POST' && call.url.endsWith(suffix));

const discountTable = () => screen.getByRole('table', { name: 'قاعده‌های تخفیف' });
const cashbackTable = () => screen.getByRole('table', { name: 'قاعده‌های کش‌بک' });

describe('the discount rules list', () => {
  it('renders the rows the server sent, with live redemptions against the limits', async () => {
    stubApi(lists());
    render();
    expect(await screen.findByText('Summer launch')).toBeInTheDocument();
    const table = discountTable();
    expect(within(table).getByText('Autumn automatic')).toBeInTheDocument();
    expect(within(table).getByText('SUMMER25')).toBeInTheDocument();

    const first = within(table).getByText('Summer launch').closest('tr') as HTMLElement;
    // 37 LIVE redemptions of 100, and one per customer.
    expect(first.textContent).toContain('37');
    expect(first.textContent).toContain('100');
    expect(first.textContent).toContain('25');
    expect(first.textContent).toContain('درصد');
    expect(first.textContent).toContain('خرید سرویس جدید');
    expect(first.textContent).toContain('تمدید');
    expect(within(first).getByText('غیرفعال')).toBeInTheDocument();

    const second = within(table).getByText('Autumn automatic').closest('tr') as HTMLElement;
    // A fixed amount is money in its own currency, and no limit is said as no limit.
    expect(second.textContent).toContain('20,000');
    expect(second.textContent).toContain('بی‌سقف');
    expect(second.textContent).toContain('قابل ترکیب');
    expect(within(second).getByText('فعال')).toBeInTheDocument();
  });

  it('filters by kind and status on the server, and pages forward by cursor', async () => {
    const api = stubApi(lists([discount()], 'cursor-2'));
    render();
    await screen.findByText('Summer launch');

    // The discount list's own pager: the cashback list has one too.
    const discountCard = discountTable().closest('section') as HTMLElement;
    fireEvent.click(within(discountCard).getByRole('button', { name: 'تازه‌تر' }));
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.includes('/discounts?cursor=cursor-2'))).toBe(true),
    );

    fireEvent.click(screen.getByRole('button', { name: 'خودکار' }));
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.endsWith('/discounts?kind=AUTOMATIC'))).toBe(true),
    );
    // A new filter starts from the first page: a cursor minted under another filter
    // would strand every row before it.
    const last = api.calls.filter((call) => call.url.includes('/discounts')).at(-1);
    expect(last?.url).not.toContain('cursor=');

    fireEvent.click(
      within(within(discountCard).getAllByRole('group')[1]!).getByRole('button', { name: 'فعال' }),
    );
    await waitFor(() =>
      expect(
        api.calls.some((call) => call.url.endsWith('/discounts?kind=AUTOMATIC&status=ACTIVE')),
      ).toBe(true),
    );
  });

  it('says there are none rather than drawing an empty table', async () => {
    stubApi(lists([]));
    render();
    expect(await screen.findByText('هنوز قاعدهٔ تخفیفی ثبت نشده است.')).toBeInTheDocument();
  });
});

describe('writing a discount', () => {
  it('creates with the body the contract declares, a key, and no status', async () => {
    /*
     * The list and the create share a PATH, and the harness routes by URL alone. One body
     * answers both: each schema strips the other's keys, so the GET parses as a page and
     * the POST as one discount.
     */
    const api = stubApi([
      {
        url: '/discounts',
        body: { discounts: [discount()], nextCursor: null, discount: discount() },
      },
      { url: '/cashback-rules', body: { rules: [], nextCursor: null } },
    ]);
    render();
    await screen.findByText('Summer launch');

    fireEvent.change(input('discount-create-code'), { target: { value: 'WELCOME10' } });
    fireEvent.change(input('discount-create-label'), { target: { value: 'Welcome' } });
    fireEvent.change(input('discount-create-value'), { target: { value: '10' } });
    fireEvent.change(input('discount-create-total-limit'), { target: { value: '500' } });
    fireEvent.change(input('discount-create-priority'), { target: { value: '10' } });

    fireEvent.click(screen.getByRole('button', { name: 'ساخت قاعده' }));
    await waitFor(() => expect(posts(api, '/discounts')).toHaveLength(1));
    const body = posts(api, '/discounts')[0]?.body as Record<string, unknown>;
    expect(body).toEqual({
      kind: 'CODE',
      code: 'WELCOME10',
      label: 'Welcome',
      type: 'PERCENTAGE',
      value: '10',
      // A percentage carries no currency: the pair moves together.
      currency: null,
      appliesTo: ['NEW_SERVICE'],
      productId: null,
      categoryId: null,
      customerId: null,
      firstPurchaseOnly: false,
      minimumSubtotalAmount: null,
      startsAt: null,
      endsAt: null,
      totalRedemptionsLimit: 500,
      perCustomerLimit: null,
      priority: 10,
      stackable: false,
      idempotencyKey: expect.any(String),
    });
    // Created INACTIVE by the server; the form never asks.
    expect(body).not.toHaveProperty('status');
    const createCard = input('discount-create-label').closest('section') as HTMLElement;
    expect(within(createCard).getByText(/غیرفعال ساخته می‌شود/)).toBeInTheDocument();
  });

  it('refuses a first-purchase rule that also applies to renewals, before sending', async () => {
    const api = stubApi(lists());
    render();
    await screen.findByText('Summer launch');
    fireEvent.change(input('discount-create-code'), { target: { value: 'FIRST' } });
    fireEvent.change(input('discount-create-label'), { target: { value: 'First' } });
    fireEvent.change(input('discount-create-value'), { target: { value: '10' } });
    fireEvent.click(input('discount-create-first'));
    // Still only NEW_SERVICE: allowed.
    expect(screen.getByRole('button', { name: 'ساخت قاعده' })).toBeEnabled();

    const createCard = input('discount-create-label').closest('section') as HTMLElement;
    fireEvent.click(within(createCard).getByLabelText('تمدید'));
    expect(screen.getByRole('button', { name: 'ساخت قاعده' })).toBeDisabled();
    expect(within(createCard).getByText(/قاعدهٔ خرید نخست/)).toBeInTheDocument();
    expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('shows kind and code read-only on edit and sends the STORED values back', async () => {
    const api = stubApi([
      ...lists(),
      { url: `/discounts/${CODE_ID}`, body: { discount: discount({ label: 'Renamed' }) } },
    ]);
    render();
    await screen.findByText('Summer launch');

    const row = within(discountTable()).getByText('Summer launch').closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'ویرایش' }));

    expect(await screen.findByText('ویرایش قاعدهٔ تخفیف')).toBeInTheDocument();
    // Neither is an input on the edit form, not even a disabled one.
    expect(document.getElementById('discount-edit-kind')).toBeNull();
    expect(document.getElementById('discount-edit-code')).toBeNull();
    const editCard = input('discount-edit-label').closest('section') as HTMLElement;
    expect(within(editCard).getByText('SUMMER25')).toBeInTheDocument();
    expect(within(editCard).getByText(/تغییر نمی‌کنند/)).toBeInTheDocument();

    fireEvent.change(input('discount-edit-label'), { target: { value: 'Renamed' } });
    fireEvent.click(within(editCard).getByRole('button', { name: 'ذخیره' }));

    await waitFor(() => expect(posts(api, `/discounts/${CODE_ID}`)).toHaveLength(1));
    const body = posts(api, `/discounts/${CODE_ID}`)[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      kind: 'CODE',
      code: 'SUMMER25',
      label: 'Renamed',
      type: 'PERCENTAGE',
      value: '25',
      currency: null,
      appliesTo: ['NEW_SERVICE', 'RENEW'],
      totalRedemptionsLimit: 100,
      perCustomerLimit: 1,
      priority: 50,
      stackable: false,
      // The stored instant, seconds and all.
      startsAt: '2026-10-01T08:30:15.000Z',
      endsAt: null,
    });
    expect(typeof body['idempotencyKey']).toBe('string');
    expect(body).not.toHaveProperty('status');
  });

  it('activates and deactivates through their own routes, each with a key', async () => {
    const api = stubApi([
      ...lists(),
      { url: `/discounts/${CODE_ID}/activate`, body: { discount: discount({ status: 'ACTIVE' }) } },
      {
        url: `/discounts/${AUTO_ID}/deactivate`,
        body: { discount: discount({ id: AUTO_ID, status: 'INACTIVE' }) },
      },
    ]);
    render();
    await screen.findByText('Summer launch');
    const table = discountTable();

    const inactive = within(table).getByText('Summer launch').closest('tr') as HTMLElement;
    fireEvent.click(within(inactive).getByRole('button', { name: 'فعال کردن' }));
    await waitFor(() => expect(posts(api, `/discounts/${CODE_ID}/activate`)).toHaveLength(1));
    expect(posts(api, `/discounts/${CODE_ID}/activate`)[0]?.body).toEqual({
      idempotencyKey: expect.any(String),
    });

    const active = within(table).getByText('Autumn automatic').closest('tr') as HTMLElement;
    await waitFor(() =>
      expect(within(active).getByRole('button', { name: 'غیرفعال کردن' })).toBeEnabled(),
    );
    fireEvent.click(within(active).getByRole('button', { name: 'غیرفعال کردن' }));
    await waitFor(() => expect(posts(api, `/discounts/${AUTO_ID}/deactivate`)).toHaveLength(1));
    expect(posts(api, `/discounts/${AUTO_ID}/deactivate`)[0]?.body).toEqual({
      idempotencyKey: expect.any(String),
    });
    // No delete, anywhere.
    expect(api.calls.some((call) => call.method === 'DELETE')).toBe(false);
  });
});

describe('cashback rules', () => {
  it('lists, creates with a key, and deactivates through its own route', async () => {
    const api = stubApi([
      ...lists(),
      {
        url: `/cashback-rules/${CASHBACK_ID}/deactivate`,
        body: { rule: cashbackRule({ status: 'INACTIVE' }) },
      },
    ]);
    render();
    expect(await screen.findByText('Loyalty five')).toBeInTheDocument();
    const row = within(cashbackTable()).getByText('Loyalty five').closest('tr') as HTMLElement;
    expect(row.textContent).toContain('5');
    expect(row.textContent).toContain('همیشه');

    fireEvent.click(within(row).getByRole('button', { name: 'غیرفعال کردن' }));
    await waitFor(() =>
      expect(posts(api, `/cashback-rules/${CASHBACK_ID}/deactivate`)).toHaveLength(1),
    );
    expect(posts(api, `/cashback-rules/${CASHBACK_ID}/deactivate`)[0]?.body).toEqual({
      idempotencyKey: expect.any(String),
    });
  });

  it('sends the cashback write body to the create route', async () => {
    // One body for the list and the create, for the reason the discount create gives.
    const api = stubApi([
      { url: '/discounts', body: { discounts: [], nextCursor: null } },
      {
        url: '/cashback-rules',
        body: { rules: [], nextCursor: null, rule: cashbackRule() },
      },
    ]);
    render();
    await screen.findByText('هنوز قاعدهٔ کش‌بکی ثبت نشده است.');

    fireEvent.change(input('cashback-create-label'), { target: { value: 'Loyalty' } });
    fireEvent.change(input('cashback-create-percent'), { target: { value: '7' } });
    fireEvent.change(input('cashback-create-scope'), { target: { value: 'PRODUCT' } });
    // Products are unrouted here, so the field is a typed id and says why.
    fireEvent.change(input('cashback-create-product'), { target: { value: PRODUCT_ID } });
    fireEvent.click(screen.getByRole('button', { name: 'ساخت قاعدهٔ کش‌بک' }));

    await waitFor(() => expect(posts(api, '/cashback-rules')).toHaveLength(1));
    expect(posts(api, '/cashback-rules')[0]?.body).toEqual({
      label: 'Loyalty',
      percent: 7,
      appliesTo: ['NEW_SERVICE'],
      productId: PRODUCT_ID,
      categoryId: null,
      startsAt: null,
      endsAt: null,
      idempotencyKey: expect.any(String),
    });
  });
});

describe('permissions', () => {
  it('draws no discount control without catalog.discounts.edit, and names the key', async () => {
    stubApi(lists());
    render({ mayEditDiscounts: false });
    await screen.findByText('Summer launch');
    const table = discountTable();
    expect(within(table).queryByRole('button')).toBeNull();
    expect(document.getElementById('discount-create-label')).toBeNull();
    expect(screen.getByText(/catalog\.discounts\.edit/)).toBeInTheDocument();
    // The other key is its own question: the cashback controls are still here.
    expect(within(cashbackTable()).getByRole('button', { name: 'ویرایش' })).toBeInTheDocument();
    expect(document.getElementById('cashback-create-label')).not.toBeNull();
  });

  it('draws no cashback control without catalog.pricing.edit, and names the key', async () => {
    stubApi(lists());
    render({ mayEditCashback: false });
    await screen.findByText('Loyalty five');
    expect(within(cashbackTable()).queryByRole('button')).toBeNull();
    expect(document.getElementById('cashback-create-label')).toBeNull();
    expect(screen.getByText(/catalog\.pricing\.edit/)).toBeInTheDocument();
    expect(within(discountTable()).getAllByRole('button', { name: 'ویرایش' })).toHaveLength(2);
  });

  it('asks the server nothing without catalog.view', async () => {
    const api = stubApi(lists());
    render({ denied: true, mayEditDiscounts: false, mayEditCashback: false });
    expect((await screen.findAllByText('شما به این بخش دسترسی ندارید.')).length).toBeGreaterThan(0);
    expect(api.calls).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'محاسبه' })).toBeNull();
  });
});

describe('the price preview', () => {
  const preview = {
    quote: {
      productId: PRODUCT_ID,
      quotedAt: '2026-09-23T10:00:00.000Z',
      currency: 'IRT',
      finalAmount: { amountMinor: '187500', currency: 'IRT' },
      trace: [
        {
          step: 'BASE_PRICE',
          effect: 'REPLACES',
          ruleId: null,
          ruleLabel: 'list price',
          amountBefore: { amountMinor: '0', currency: 'IRT' },
          amountAfter: { amountMinor: '250000', currency: 'IRT' },
        },
        {
          step: 'PROMOTIONAL_DISCOUNT',
          effect: 'ADJUSTS',
          ruleId: CODE_ID,
          ruleLabel: 'Summer launch',
          amountBefore: { amountMinor: '250000', currency: 'IRT' },
          amountAfter: { amountMinor: '187500', currency: 'IRT' },
        },
      ],
      cashback: {
        ruleId: CASHBACK_ID,
        ruleLabel: 'Loyalty five',
        percent: 5,
        amount: { amountMinor: '9375', currency: 'IRT' },
      },
    },
    subtotalAmount: '250000',
    discountAmount: '62500',
    totalAmount: '187500',
    currency: 'IRT',
    rules: [
      {
        discountId: CODE_ID,
        label: 'Summer launch',
        kind: 'CODE',
        outcome: 'APPLIED',
        reason: null,
      },
      {
        discountId: AUTO_ID,
        label: 'Autumn automatic',
        kind: 'AUTOMATIC',
        outcome: 'SKIPPED',
        reason: 'NOT_COMBINABLE',
      },
      {
        discountId: '019250ab-cdef-7012-8345-6789abcdef03',
        label: 'Spring',
        kind: 'AUTOMATIC',
        outcome: 'INELIGIBLE',
        reason: 'ENDED',
      },
      {
        discountId: '019250ab-cdef-7012-8345-6789abcdef04',
        label: 'Welcome back',
        kind: 'AUTOMATIC',
        outcome: 'CUSTOMER_DEPENDENT',
        reason: null,
      },
    ],
    code: { accepted: true, reason: null },
  };

  it('asks the engine with the query it was given, and renders its outcomes and cashback', async () => {
    const api = stubApi([...lists(), { url: '/pricing/preview', body: preview }]);
    const { container } = render();
    await screen.findByText('Summer launch');

    const run = screen.getByRole('button', { name: 'محاسبه' });
    // Nothing to price yet.
    expect(run).toBeDisabled();
    fireEvent.change(input('preview-product'), { target: { value: PRODUCT_ID } });
    fireEvent.change(input('preview-code'), { target: { value: 'summer25' } });
    fireEvent.click(run);

    const table = await screen.findByRole('table', { name: 'قاعده‌های بررسی‌شده' });
    const sent = api.calls.find((call) => call.url.includes('/pricing/preview'));
    expect(sent?.method).toBe('GET');
    expect(sent?.url).toContain(
      `/pricing/preview?purpose=NEW_SERVICE&productId=${PRODUCT_ID}&code=summer25`,
    );
    // A GET that writes nothing: no POST was made to preview a price.
    expect(api.calls.some((call) => call.method === 'POST')).toBe(false);

    const outcome = (label: string) =>
      (within(table).getByText(label).closest('tr') as HTMLElement).textContent ?? '';
    expect(outcome('Summer launch')).toContain('اعمال شد');
    expect(outcome('Autumn automatic')).toContain('کنار گذاشته شد');
    expect(outcome('Autumn automatic')).toContain('با قاعدهٔ اعمال‌شدهٔ دیگری ترکیب نمی‌شود');
    expect(outcome('Spring')).toContain('شامل نمی‌شود');
    expect(outcome('Spring')).toContain('به پایان رسیده است');
    expect(outcome('Welcome back')).toContain('وابسته به مشتری');

    const text = container.textContent ?? '';
    expect(text).toContain('250,000');
    expect(text).toContain('62,500');
    expect(text).toContain('187,500');
    // The cashback the quote promised, by rule, percent and amount.
    expect(text).toContain('Loyalty five');
    expect(text).toContain('9,375');
    expect(screen.getByText('پذیرفته شد')).toBeInTheDocument();
  });

  it('names the code refusal reason, and says when no cashback applies', async () => {
    stubApi([
      ...lists(),
      {
        url: '/pricing/preview',
        body: {
          ...preview,
          quote: { ...preview.quote, cashback: undefined },
          rules: [],
          code: { accepted: false, reason: 'TOTAL_LIMIT' },
        },
      },
    ]);
    render();
    await screen.findByText('Summer launch');
    fireEvent.change(input('preview-product'), { target: { value: PRODUCT_ID } });
    fireEvent.change(input('preview-code'), { target: { value: 'SUMMER25' } });
    fireEvent.click(screen.getByRole('button', { name: 'محاسبه' }));

    expect(await screen.findByText('پذیرفته نشد')).toBeInTheDocument();
    expect(screen.getByText(/سقف کل استفاده پر شده است/)).toBeInTheDocument();
    expect(screen.getByText('هیچ قاعدهٔ کش‌بکی بر این سفارش اعمال نمی‌شود.')).toBeInTheDocument();
  });

  it('prices an add-on purchase from an add-on id, never a product id', async () => {
    const api = stubApi([...lists(), { url: '/pricing/preview', body: preview }]);
    render();
    await screen.findByText('Summer launch');
    fireEvent.change(input('preview-purpose'), { target: { value: 'ADD_TRAFFIC' } });
    expect(document.getElementById('preview-product')).toBeNull();
    const addon = '019270ab-cdef-7012-8345-6789abcdef01';
    fireEvent.change(input('preview-addon'), { target: { value: addon } });
    fireEvent.click(screen.getByRole('button', { name: 'محاسبه' }));
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.includes('/pricing/preview'))).toBe(true),
    );
    const sent = api.calls.find((call) => call.url.includes('/pricing/preview'));
    expect(sent?.url).toContain(`purpose=ADD_TRAFFIC&addonId=${addon}`);
    expect(sent?.url).not.toContain('productId');
  });
});

describe("an order's pricing", () => {
  const pricing = (cashback: Record<string, unknown> | null) => ({
    orderId: ORDER_ID,
    discountCode: 'SUMMER25',
    subtotalAmount: '250000',
    discountAmount: '62500',
    totalAmount: '187500',
    currency: 'IRT',
    adjustments: [
      {
        ruleId: CODE_ID,
        label: 'Summer launch',
        amountBefore: '250000',
        amountAfter: '187500',
      },
    ],
    redemptions: [{ discountId: CODE_ID, amount: '62500', createdAt: '2026-09-10T12:31:00.000Z' }],
    cashback,
  });

  const detail = (cashback: Record<string, unknown> | null) => {
    stubApi([
      { url: `/orders/${ORDER_ID}`, body: { order: order({ state: 'PAID' }) } },
      { url: `/orders/${ORDER_ID}/pricing`, body: pricing(cashback) },
    ]);
    return renderPage(
      <OrderDetailPage
        id={ORDER_ID}
        denied={false}
        mayViewPayments={false}
        mayViewServices={false}
      />,
    );
  };

  it('renders the code, the adjustments, the redemptions and an unrecovered reversal', async () => {
    const { container } = detail({
      ruleId: CASHBACK_ID,
      label: 'Loyalty five',
      percent: 5,
      promisedAmount: '9375',
      state: 'EARNED',
      earnedAmount: '9375',
      reversedAmount: '4687',
      unrecoveredAmount: '1200',
    });
    const adjustments = await screen.findByRole('table', { name: 'تعدیل‌های تخفیف' });
    const step = within(adjustments).getByText('Summer launch').closest('tr') as HTMLElement;
    expect(step.textContent).toContain('250,000');
    expect(step.textContent).toContain('187,500');

    const redemptions = screen.getByRole('table', { name: 'استفاده‌های ثبت‌شده' });
    expect(redemptions.textContent).toContain('62,500');
    expect(redemptions.textContent).toContain(CODE_ID);

    expect(screen.getByText('SUMMER25')).toBeInTheDocument();
    expect(screen.getByText('واریز شده')).toBeInTheDocument();
    const text = container.textContent ?? '';
    expect(text).toContain('9,375');
    expect(text).toContain('4,687');
    expect(text).toContain('1,200');
    // Recorded, and said never to be collected.
    expect(text).toContain('هرگز از مشتری مطالبه نمی‌شود');
  });

  it("says a draft's cashback is not recorded yet, and draws no unrecovered notice at zero", async () => {
    const { container } = detail({
      ruleId: CASHBACK_ID,
      label: 'Loyalty five',
      percent: 5,
      promisedAmount: '9375',
      state: null,
      earnedAmount: '0',
      reversedAmount: '0',
      unrecoveredAmount: '0',
    });
    expect(await screen.findByText(/هنگام تأیید سفارش ثبت می‌شود/)).toBeInTheDocument();
    expect(container.textContent).not.toContain('هرگز از مشتری مطالبه نمی‌شود');
  });

  it('says there is no cashback when the quote promised none', async () => {
    detail(null);
    expect(await screen.findByText('قیمت این سفارش کش‌بکی در بر ندارد.')).toBeInTheDocument();
  });
});

/**
 * The promotion itself, asserted through the route table an operator actually reaches.
 */
describe('the promotion of /discounts', () => {
  it('resolves the real page, not the planned placeholder', async () => {
    stubApi(lists());
    const resolved = resolve({ path: '/discounts', query: new URLSearchParams() }, [
      'catalog.view',
    ]);
    const view = renderPage(resolved.element as ReactElement);
    expect(await within(view.container).findByText('Summer launch')).toBeInTheDocument();
    expect(within(view.container).queryByText('چرا هنوز فعال نیست')).toBeNull();
    // The route derived the write keys from the permissions: a reader gets no create form.
    expect(document.getElementById('discount-create-label')).toBeNull();
    expect(document.getElementById('cashback-create-label')).toBeNull();
  });

  it('derives each write affordance from its own key at the route', async () => {
    stubApi(lists());
    const resolved = resolve({ path: '/discounts', query: new URLSearchParams() }, [
      'catalog.view',
      'catalog.pricing.edit',
    ]);
    renderPage(resolved.element as ReactElement);
    await screen.findByText('Summer launch');
    expect(document.getElementById('discount-create-label')).toBeNull();
    expect(document.getElementById('cashback-create-label')).not.toBeNull();
  });

  it('is gone from PLANNED_SURFACES, so the placeholder cannot shadow it', () => {
    expect(PLANNED_SURFACES.map((surface) => surface.key)).not.toContain('discounts');
  });

  it('offers the link on catalog.view, and not on a write key alone', () => {
    const entry = NAV.find((candidate) => candidate.id === 'discounts');
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(navPermitted(entry, ['catalog.view'])).toBe(true);
    expect(navPermitted(entry, ['catalog.discounts.edit'])).toBe(false);
    expect(navPermitted(entry, ['catalog.pricing.edit'])).toBe(false);
    expect(navPermitted(entry, [])).toBe(false);
  });
});
