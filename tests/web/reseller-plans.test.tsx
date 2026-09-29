import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { NAV, navPermitted, resolve } from '../../apps/web/src/app';
import {
  ResellerPlansPage,
  grantsInWords,
  minimumAmountOf,
  overridesBodyFrom,
  progressPercentOf,
} from '../../apps/web/src/pages/reseller-plans';
import { grantsStateOf } from '../../apps/web/src/pages/reseller-tiers';
import { renderPage, stubApi, type Api } from './harness';

/**
 * Round N, package D on the Web Admin: «تنظیمات نمایندگان / پلن‌ها و حداقل فروش».
 *
 * Every response goes through the real client and the contract schemas. The cases hold
 * what the screen DOES: find the page in the navigation, draw the server's figures without
 * computing any, ask for the progress only with `orders.view`, send a tier minimum and a
 * reseller's override exactly as the server reads them — an inherited dimension is never
 * sent, and "no minimum" is a null on a tier and a zero on a reseller — and say in words
 * that nothing happens to a reseller below the minimum.
 */

const CUSTOMER_ID = '019210ab-cdef-7012-8345-6789abcdef01';
const TIER_ID = '019290ab-cdef-7012-8345-6789abcdef01';
const PRODUCT_ID = '0192b0ab-cdef-7012-8345-6789abcdef01';
const OTHER_PRODUCT_ID = '0192b0ab-cdef-7012-8345-6789abcdef02';
const PANEL_ID = '0192c0ab-cdef-7012-8345-6789abcdef01';

const IRT = (amount: string) => ({ amount, currency: 'IRT' as const });

const tier = (overrides: Record<string, unknown> = {}) => ({
  id: TIER_ID,
  name: 'Gold',
  pricingMode: 'PERCENTAGE_DISCOUNT',
  discountPercentage: 20,
  creditLimit: IRT('0'),
  grants: [
    { kind: 'OPERATION', subject: null },
    { kind: 'PRODUCT', subject: null },
    { kind: 'PANEL', subject: PANEL_ID },
    { kind: 'BOT', subject: null },
  ],
  resellerCount: 1,
  monthlyMinimum: IRT('1000000'),
  createdAt: '2026-09-01T08:00:00.000Z',
  updatedAt: '2026-09-01T08:00:00.000Z',
  ...overrides,
});

const row = (overrides: Record<string, unknown> = {}) => ({
  customerId: CUSTOMER_ID,
  telegramUserId: '5551234567',
  displayName: 'Reza Reseller',
  tier: { id: TIER_ID, name: 'Gold' },
  status: 'ACTIVE',
  minimum: IRT('1000000'),
  source: 'TIER',
  achieved: IRT('600000'),
  remaining: IRT('400000'),
  progressBasisPoints: 6_000,
  state: 'BELOW',
  ...overrides,
});

const report = (rows = [row()]) => ({
  period: {
    key: 'THIS_MONTH',
    start: '2026-09-22T20:30:00.000Z',
    end: '2026-10-22T20:30:00.000Z',
    startLocal: '1405/07/01',
    endLocalInclusive: '1405/07/30',
    timezone: 'Asia/Tehran',
    calendar: 'jalali',
    running: true,
  },
  rows,
  counts: { achieved: 0, below: 1, noMinimum: 0, notActive: 0 },
  truncated: false,
});

const policy = (overrides: Record<string, unknown> = {}) => ({
  customerId: CUSTOMER_ID,
  status: 'ACTIVE',
  tier: { id: TIER_ID, name: 'Gold' },
  dimensions: [
    {
      dimension: 'OPERATION',
      source: 'TIER',
      tierGrants: [{ kind: 'OPERATION', subject: null }],
      overrideGrants: null,
      effectiveGrants: [{ kind: 'OPERATION', subject: null }],
    },
    {
      dimension: 'CATALOGUE',
      source: 'RESELLER',
      tierGrants: [{ kind: 'PRODUCT', subject: null }],
      overrideGrants: [{ kind: 'PRODUCT', subject: PRODUCT_ID }],
      effectiveGrants: [{ kind: 'PRODUCT', subject: PRODUCT_ID }],
    },
    {
      dimension: 'PANEL',
      source: 'TIER',
      tierGrants: [{ kind: 'PANEL', subject: PANEL_ID }],
      overrideGrants: null,
      effectiveGrants: [{ kind: 'PANEL', subject: PANEL_ID }],
    },
    {
      dimension: 'BOT',
      source: 'TIER',
      tierGrants: [{ kind: 'BOT', subject: null }],
      overrideGrants: null,
      effectiveGrants: [{ kind: 'BOT', subject: null }],
    },
  ],
  pricing: {
    tierMode: 'PERCENTAGE_DISCOUNT',
    tierPercent: 20,
    overrideMode: 'TIER',
    overridePercent: null,
    layer: 'TIER',
    percent: 20,
  },
  monthlyMinimum: {
    tier: IRT('1000000'),
    own: null,
    effective: IRT('1000000'),
    source: 'TIER',
  },
  botBasis: 'ANY_BOT',
  products: [
    {
      productId: PRODUCT_ID,
      title: 'پلن طلایی',
      status: 'ACTIVE',
      categoryId: null,
      panelId: PANEL_ID,
      allowed: true,
      refusedDimension: null,
    },
    {
      productId: OTHER_PRODUCT_ID,
      title: 'پلن نقره‌ای',
      status: 'ACTIVE',
      categoryId: null,
      panelId: PANEL_ID,
      allowed: false,
      refusedDimension: 'CATALOGUE',
    },
  ],
  productsComplete: true,
  ...overrides,
});

const routes = (rows = [row()]) => [
  { url: '/reseller-tiers', body: { tiers: [tier()] } },
  { url: '/reseller-minimums', body: report(rows) },
  { url: `/resellers/${CUSTOMER_ID}/policy`, body: { policy: policy() } },
  { url: `/resellers/${CUSTOMER_ID}/grants`, body: { policy: policy() } },
  {
    url: `/reseller-tiers/${TIER_ID}/monthly-minimum`,
    body: { tier: tier({ monthlyMinimum: IRT('2000000') }) },
  },
];

const gets = (api: Api, path: string) =>
  api.calls.filter((call) => call.method === 'GET' && call.url.includes(path));
const posts = (api: Api, path: string) =>
  api.calls.filter((call) => call.method === 'POST' && call.url.includes(path));

const render = (keys: { edit?: boolean; orders?: boolean } = {}) =>
  renderPage(
    <ResellerPlansPage
      denied={false}
      mayEdit={keys.edit ?? true}
      mayViewOrders={keys.orders ?? true}
      mayViewCatalog={false}
      mayViewPanels={false}
    />,
  );

describe('the reseller plans page', () => {
  it('is in the navigation under resellers.view and resolves with its Persian title', () => {
    const entry = NAV.find((candidate) => candidate.path === '/reseller-plans');
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(navPermitted(entry, ['resellers.view'])).toBe(true);
    expect(navPermitted(entry, [])).toBe(false);
    const resolved = resolve({ path: '/reseller-plans', query: new URLSearchParams() }, [
      'resellers.view',
    ]);
    expect(resolved.title).toBe('تنظیمات نمایندگان / پلن‌ها و حداقل فروش');
    expect(resolved.element as ReactElement).toBeTruthy();
  });

  it('draws each tier’s allowed Products, panels and monthly minimum in words', async () => {
    stubApi(routes());
    render();
    const cell = await screen.findByText('Gold', { selector: 'strong' });
    const tableRow = cell.closest('tr') ?? document.body;
    const text = tableRow.textContent ?? '';
    expect(text).toContain('محصول: همه');
    expect(text).toContain('1,000,000');
    // No raw enum reaches the operator.
    expect(text).not.toContain('PERCENTAGE_DISCOUNT');
    expect(text).not.toContain('PRODUCT');
  });

  it('draws the server’s progress figures, and says nothing happens below the minimum', async () => {
    stubApi(routes());
    render();
    const name = await screen.findByText('Reza Reseller');
    const text = name.closest('tr')?.textContent ?? '';
    expect(text).toContain('600,000');
    expect(text).toContain('400,000');
    expect(text).toContain('60');
    expect(text).toContain('هنوز نرسیده');
    expect(screen.getByText('1405/07/01')).toBeInTheDocument();
    expect(screen.getByText('1405/07/30')).toBeInTheDocument();
    expect(
      screen.getByText((content) => content.includes('هیچ بدهی، کارمزد، کسر از کیف پول')),
    ).toBeInTheDocument();
  });

  it('sends the period and the filter to the server and filters nothing itself', async () => {
    const api = stubApi(routes());
    render();
    await screen.findByText('Reza Reseller');
    fireEvent.click(screen.getByRole('button', { name: 'ماه قبل' }));
    await waitFor(() =>
      expect(gets(api, 'period=PREVIOUS_MONTH').length).toBeGreaterThanOrEqual(1),
    );
    fireEvent.click(screen.getByRole('button', { name: 'رسیده به حداقل' }));
    await waitFor(() => expect(gets(api, 'filter=ACHIEVED').length).toBeGreaterThanOrEqual(1));
  });

  it('asks for no progress without orders.view, and says why', async () => {
    const api = stubApi(routes());
    render({ orders: false });
    await screen.findByText('Gold', { selector: 'strong' });
    expect(gets(api, '/reseller-minimums')).toHaveLength(0);
    expect(screen.getByText(/orders\.view/u)).toBeInTheDocument();
  });

  it('saves a tier minimum as the server reads it, and a zero as “none”', async () => {
    const api = stubApi(routes());
    render();
    fireEvent.click(await screen.findByRole('button', { name: 'حداقل فروش' }));
    const amount = await screen.findByLabelText('مبلغ حداقل (واحد خرد)');
    fireEvent.change(amount, { target: { value: '2000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));
    await waitFor(() => expect(posts(api, '/monthly-minimum')).toHaveLength(1));
    expect(posts(api, '/monthly-minimum')[0]?.body).toMatchObject({
      minimum: { amount: '2000000', currency: 'IRT' },
    });

    fireEvent.click(await screen.findByRole('button', { name: 'حداقل فروش' }));
    fireEvent.change(await screen.findByLabelText('مبلغ حداقل (واحد خرد)'), {
      target: { value: '0' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));
    await waitFor(() => expect(posts(api, '/monthly-minimum')).toHaveLength(2));
    expect(posts(api, '/monthly-minimum')[1]?.body).toMatchObject({ minimum: null });
  });

  it('previews inherited vs own vs effective, with the server’s answer per Product', async () => {
    stubApi(routes());
    render();
    fireEvent.click(await screen.findByRole('button', { name: 'سیاست مؤثر' }));
    const card =
      (await screen.findByText('سیاست مؤثر نماینده')).closest('section') ?? document.body;
    await within(card as HTMLElement).findByText('پلن طلایی');
    const text = card.textContent ?? '';
    expect(text).toContain('مطابق سطح');
    expect(text).toContain('اختصاصی');
    expect(text).toContain('مجاز نیست');
    expect(text).toContain('نرخ سطح');
    expect(text).not.toContain('CATALOGUE');
  });

  it('sends only the dimensions marked own, and never an inherited one', async () => {
    const api = stubApi(routes());
    render();
    fireEvent.click(await screen.findByRole('button', { name: 'سیاست مؤثر' }));
    fireEvent.click(await screen.findByRole('button', { name: 'ویرایش تنظیمات اختصاصی' }));
    fireEvent.click(screen.getByRole('button', { name: 'ذخیرهٔ مجوزهای اختصاصی' }));
    await waitFor(() => expect(posts(api, '/grants')).toHaveLength(1));
    expect(posts(api, '/grants')[0]?.body).toMatchObject({
      overrides: [{ dimension: 'CATALOGUE', grants: [{ kind: 'PRODUCT', subject: PRODUCT_ID }] }],
    });
  });
});

describe('the pure helpers', () => {
  it('reads a minimum in minor units, digits only and bounded', () => {
    expect(minimumAmountOf('010')).toBe('10');
    expect(minimumAmountOf('0')).toBe('0');
    expect(minimumAmountOf('-5')).toBeNull();
    expect(minimumAmountOf('1.5')).toBeNull();
    expect(minimumAmountOf('1000000000001')).toBeNull();
  });

  it('floors the progress, so one unit short is never 100%', () => {
    expect(progressPercentOf(9_999)).toBe(99);
    expect(progressPercentOf(10_000)).toBe(100);
    expect(progressPercentOf(25_000)).toBe(250);
  });

  it('masks inherited dimensions and sends an own dimension with nothing as “nothing”', () => {
    const state = grantsStateOf([
      { kind: 'OPERATION', subject: null },
      { kind: 'PRODUCT', subject: PRODUCT_ID },
      // An unfinished SOME with nothing in an INHERITED dimension must not block the body.
      { kind: 'PANEL', subject: PANEL_ID },
    ]);
    const unfinished = { ...state, PANEL: { mode: 'SOME' as const, subjects: [], typed: '' } };
    expect(overridesBodyFrom(unfinished, new Set(['CATALOGUE', 'BOT']), new Set())).toEqual({
      overrides: [
        { dimension: 'CATALOGUE', grants: [{ kind: 'PRODUCT', subject: PRODUCT_ID }] },
        { dimension: 'BOT', grants: [] },
      ],
    });
    expect(overridesBodyFrom(unfinished, new Set(['PANEL']), new Set())).toEqual({
      problem: 'web.reseller_grants_problem_empty',
    });
  });

  it('says a grant set in words, «همه» for a null subject and «هیچ» for none', () => {
    const names = new Map([[PRODUCT_ID, 'پلن طلایی']]);
    expect(
      grantsInWords([{ kind: 'PRODUCT', subject: null }], ['PRODUCT', 'CATEGORY'], names),
    ).toBe('محصول: همه');
    expect(grantsInWords([{ kind: 'PRODUCT', subject: PRODUCT_ID }], ['PRODUCT'], names)).toBe(
      'محصول: پلن طلایی',
    );
    expect(grantsInWords([], ['PANEL'], names)).toBe('هیچ');
  });
});
