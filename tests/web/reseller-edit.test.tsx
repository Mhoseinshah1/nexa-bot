import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ProductSummaryResponse, ResellerPolicy } from '@nexa/contracts';
import { ResellersPage } from '../../apps/web/src/pages/resellers';
import {
  allowedIdsOf,
  catalogueGrantsFor,
  groupProducts,
} from '../../apps/web/src/pages/reseller-products';
import { formatDate } from '../../apps/web/src/format';
import { t } from '../../apps/web/src/i18n/web.fa';
import { categoryListing, product, renderPage, stubApi, type Api } from './harness';
import { RESELLER_TABS, openResellerTab } from './reseller-helpers';

/**
 * PR-6 (v0.9.5): the reseller edit view. Every former section of the page is reachable from
 * a tab; the allowed-products tab groups the catalogue, toggles by chip and saves through the
 * one existing grant route; nothing on it says where a record came from.
 */

const CUSTOMER_ID = '019210ab-cdef-7012-8345-6789abcdef01';
const TIER_ID = '019290ab-cdef-7012-8345-6789abcdef01';
const CAT_A = '01a05e35-c9ad-7e93-bef3-1ed9b55292ca';
const CAT_B = '01a05e35-c9ad-7e93-bef3-1ed9b55292cb';
const P1 = '019220ab-cdef-7012-8345-6789abcdef11';
const P2 = '019220ab-cdef-7012-8345-6789abcdef12';
const P3 = '019220ab-cdef-7012-8345-6789abcdef13';
const L1 = '019220ab-cdef-7012-8345-6789abcdef21';
const L2 = '019220ab-cdef-7012-8345-6789abcdef22';

const IRT = (amount: string) => ({ amount, currency: 'IRT' as const });

const reseller = (overrides: Record<string, unknown> = {}) => ({
  customerId: CUSTOMER_ID,
  telegramUserId: '5551234567',
  displayName: 'Reza Reseller',
  tier: { id: TIER_ID, name: 'Gold' },
  status: 'ACTIVE',
  pricingMode: 'TIER',
  discountPercentage: null,
  creditLimit: null,
  effectiveCreditLimit: IRT('0'),
  source: 'MIRZA',
  createdAt: '2026-09-02T08:00:00.000Z',
  updatedAt: '2026-09-02T08:00:00.000Z',
  ...overrides,
});

const tier = {
  id: TIER_ID,
  name: 'Gold',
  pricingMode: 'PERCENTAGE_DISCOUNT',
  discountPercentage: 20,
  creditLimit: IRT('0'),
  grants: [],
  resellerCount: 1,
  monthlyMinimum: null,
  createdAt: '2026-09-01T08:00:00.000Z',
  updatedAt: '2026-09-01T08:00:00.000Z',
};

const policy = (
  effective: readonly Record<string, unknown>[] = [{ kind: 'PRODUCT', subject: P1 }],
) => ({
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
      overrideGrants: effective,
      effectiveGrants: effective,
    },
    {
      dimension: 'PANEL',
      source: 'TIER',
      tierGrants: [{ kind: 'PANEL', subject: null }],
      overrideGrants: null,
      effectiveGrants: [{ kind: 'PANEL', subject: null }],
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
  monthlyMinimum: { tier: IRT('1000000'), own: null, effective: IRT('1000000'), source: 'TIER' },
  botBasis: 'ANY_BOT',
  products: [],
  productsComplete: true,
});

const products = [
  product({ id: P1, title: 'پلن الف', categoryId: CAT_A }),
  product({ id: P2, title: 'پلن ب', categoryId: CAT_A }),
  product({ id: P3, title: 'پلن ج', categoryId: CAT_B }),
  product({ id: L1, title: 'قدیمی یک', categoryId: null, source: 'MIRZA' }),
  product({ id: L2, title: 'قدیمی دو', categoryId: null, source: 'MIRZA' }),
];

const credit = {
  customerId: CUSTOMER_ID,
  status: 'ACTIVE',
  effectiveLimit: IRT('0'),
  limitSource: 'TIER',
  sellingCurrency: 'IRT',
  credit: 'NO_LIMIT',
  balance: IRT('250000'),
  allowance: IRT('0'),
  creditInUse: IRT('0'),
  availableToSpend: IRT('250000'),
  overLimitBy: IRT('0'),
};

const routes = (effective?: readonly Record<string, unknown>[]) => [
  { url: '/resellers', body: { resellers: [reseller()], nextCursor: null } },
  { url: '/reseller-tiers', body: { tiers: [tier] } },
  { url: `/resellers/${CUSTOMER_ID}/policy`, body: { policy: policy(effective) } },
  { url: `/resellers/${CUSTOMER_ID}/grants`, body: { policy: policy(effective) } },
  { url: `/resellers/${CUSTOMER_ID}/credit`, body: { credit } },
  { url: `/resellers/${CUSTOMER_ID}/purchases`, body: { purchases: [], nextCursor: null } },
  { url: `/resellers/${CUSTOMER_ID}/history`, body: { entries: [] } },
  { url: `/resellers/${CUSTOMER_ID}`, body: { reseller: reseller() } },
  { url: '/products', body: { products, nextCursor: null } },
  {
    url: '/product-categories',
    body: {
      categories: [
        categoryListing({ id: CAT_A, name: 'عمومی' }),
        categoryListing({ id: CAT_B, name: 'ویژه' }),
      ],
    },
  },
];

const posts = (api: Api, path: string) =>
  api.calls.filter((call) => call.method === 'POST' && call.url.includes(path));

const render = (options: { mayViewCatalog?: boolean; mayEdit?: boolean } = {}) =>
  renderPage(
    <ResellersPage
      route={{ path: '/resellers', query: new URLSearchParams() }}
      denied={false}
      mayEdit={options.mayEdit ?? true}
      mayViewWallet
      mayViewOrders
      mayViewAudit
      mayViewCatalog={options.mayViewCatalog ?? true}
      mayViewPanels={false}
    />,
  );

const openStanding = async () => {
  await screen.findByText('Reza Reseller');
  fireEvent.click(screen.getByRole('button', { name: t('web.reseller_standing_open') }));
};

const openProducts = async () => {
  await openStanding();
  await openResellerTab('products');
  await screen.findByRole('region', { name: 'عمومی' });
};

const group = (name: string) => screen.getByRole('region', { name });
const chip = (name: string) => screen.getByRole('button', { name });
const countText = (name: string) =>
  group(name).querySelector('.rs-group-toggle .muted')?.textContent;
const total = () => screen.getByRole('progressbar', { name: t('web.rs_products_total') });
const of = (a: number, b: number) =>
  `${a} ${t('web.progress_of')} ${b} ${t('web.rs_allowed_word')}`;

describe('the reseller edit view: tabs', () => {
  it('reaches every former section from a tab, in the owner’s order', async () => {
    stubApi(routes());
    render();
    await openStanding();
    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent);
    expect(tabs).toEqual(Object.values(RESELLER_TABS).map((key) => t(key)));

    const sections = {
      profile: [t('web.rs_profile_title')],
      pricing: [t('web.rs_pricing_title')],
      credit: [
        t('web.reseller_credit_title'),
        t('web.reseller_minimum'),
        t('web.reseller_purchases_title'),
      ],
      expiry: [t('web.reseller_expiry_title'), t('web.rs_status_title'), t('web.history_title')],
      products: [t('web.rs_products_title'), t('web.rs_access_title')],
      danger: [t('web.rs_danger_title')],
    } as const;
    for (const [tab, titles] of Object.entries(sections)) {
      await openResellerTab(tab as keyof typeof RESELLER_TABS);
      for (const title of titles) {
        expect(
          await screen.findByRole('heading', { name: title }),
          `${tab}: ${title}`,
        ).toBeInTheDocument();
      }
    }
  });

  it('draws the summary from the API only, and the register date as a date', async () => {
    stubApi(routes());
    render();
    await openStanding();
    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText('250,000')).toBeInTheDocument();
    for (const label of [
      t('web.reseller_pricing'),
      t('web.rs_summary_expiry'),
      t('web.reseller_credit_balance'),
    ]) {
      expect(within(drawer).getAllByText(label).length).toBeGreaterThan(0);
    }
    await waitFor(() =>
      expect(within(drawer).getByText(`1 ${t('web.progress_of')} 5`)).toBeInTheDocument(),
    );
    const registered = within(drawer).getByText(formatDate('2026-09-02T08:00:00.000Z'));
    expect(registered.textContent).not.toMatch(/:/u);
  });

  it('keeps the sensitive fields in one danger box and one sticky Save/Cancel', async () => {
    const api = stubApi(routes());
    render();
    await openStanding();
    await openResellerTab('danger');
    expect(document.getElementById('reseller-update-status')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('web.rs_danger_edit') }));
    const box = (await screen.findByRole('heading', { name: t('web.rs_danger_title') })).closest(
      'section',
    );
    expect(box).toHaveClass('danger-zone');
    expect(box).toContainElement(document.getElementById('reseller-update-status'));
    expect(box).toContainElement(document.getElementById('reseller-update-tier'));

    // One bar, on every tab, with the form's one Save and one Cancel.
    for (const tab of ['profile', 'pricing', 'danger'] as const) {
      await openResellerTab(tab);
      expect(document.querySelectorAll('.rs-foot')).toHaveLength(1);
    }
    await openResellerTab('danger');
    const bar = document.querySelector('.rs-foot') as HTMLElement;
    fireEvent.change(document.getElementById('reseller-update-status') as HTMLElement, {
      target: { value: 'SUSPENDED' },
    });
    expect(within(bar).getByText(t('web.unsaved_changes'))).toBeInTheDocument();
    fireEvent.click(within(bar).getByRole('button', { name: t('web.rule_save') }));
    await waitFor(() => expect(posts(api, `/resellers/${CUSTOMER_ID}`)).toHaveLength(1));
    expect(posts(api, `/resellers/${CUSTOMER_ID}`)[0]?.body).toMatchObject({
      status: 'SUSPENDED',
    });
  });

  it('keeps the unsaved-changes guard: closing a dirty edit asks first', async () => {
    stubApi(routes());
    render();
    await openStanding();
    await openResellerTab('danger');
    fireEvent.click(screen.getByRole('button', { name: t('web.rs_danger_edit') }));
    fireEvent.change(await screen.findByLabelText(t('web.status')), {
      target: { value: 'SUSPENDED' },
    });
    fireEvent.click(
      within(document.getElementById('reseller-standing') as HTMLElement).getByRole('button', {
        name: t('web.close'),
      }),
    );
    expect(screen.getByRole('alertdialog', { name: t('web.unsaved_title') })).toBeInTheDocument();
  });

  it('shows nothing that names the old system, on any tab, for an imported reseller', async () => {
    stubApi(routes());
    render();
    await openStanding();
    await screen.findByText(`1 ${t('web.progress_of')} 5`);
    for (const tab of Object.keys(RESELLER_TABS) as (keyof typeof RESELLER_TABS)[]) {
      await openResellerTab(tab);
      const drawer = screen.getByRole('dialog');
      expect(drawer.textContent, tab).not.toMatch(/میرزا|Mirza|MIRZA/iu);
    }
  });
});

describe('the allowed-products tab', () => {
  it('groups by category with X از Y مجاز, and starts the imported group collapsed under its own name', async () => {
    stubApi(routes());
    render();
    await openProducts();
    expect(countText('عمومی')).toBe(of(1, 2));
    expect(countText('ویژه')).toBe(of(0, 1));
    expect(t('web.rs_group_legacy')).toBe('محصولات قدیمی');
    const legacy = group('محصولات قدیمی');
    const toggle = within(legacy).getByRole('button', { expanded: false });
    expect(screen.queryByRole('button', { name: 'قدیمی یک' })).toBeNull();
    expect(countText('محصولات قدیمی')).toBe(of(0, 2));
    fireEvent.click(toggle);
    expect(chip('قدیمی یک')).toHaveAttribute('aria-pressed', 'false');
    // The first group is open from the start.
    expect(chip('پلن الف')).toHaveAttribute('aria-pressed', 'true');
    expect(total()).toHaveAttribute('aria-valuenow', '20');
  });

  it('toggles a chip on tap, and one switch sets the whole group', async () => {
    stubApi(routes());
    render();
    await openProducts();
    fireEvent.click(chip('پلن ب'));
    expect(chip('پلن ب')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(chip('پلن ب'));
    expect(chip('پلن ب')).toHaveAttribute('aria-pressed', 'false');

    const sw = screen.getByRole('switch', { name: `${t('web.rs_group_switch')} عمومی` });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(sw);
    expect(chip('پلن الف')).toHaveAttribute('aria-pressed', 'true');
    expect(chip('پلن ب')).toHaveAttribute('aria-pressed', 'true');
    expect(countText('عمومی')).toBe(of(2, 2));
    fireEvent.click(sw);
    expect(chip('پلن الف')).toHaveAttribute('aria-pressed', 'false');
    expect(countText('عمومی')).toBe(of(0, 2));
  });

  it('has the three bulk buttons, counting the imported group too', async () => {
    stubApi(routes());
    render();
    await openProducts();
    fireEvent.click(screen.getByRole('button', { name: t('web.rs_bulk_all') }));
    expect(total()).toHaveAttribute('aria-valuenow', '100');
    expect(countText('محصولات قدیمی')).toBe(of(2, 2));
    fireEvent.click(screen.getByRole('button', { name: t('web.rs_bulk_none') }));
    expect(total()).toHaveAttribute('aria-valuenow', '0');
    fireEvent.click(screen.getByRole('button', { name: t('web.rs_bulk_all') }));
    fireEvent.click(screen.getByRole('button', { name: t('web.rs_bulk_current') }));
    expect(total()).toHaveAttribute('aria-valuenow', '60');
    expect(countText('محصولات قدیمی')).toBe(of(0, 2));
    expect(countText('ویژه')).toBe(of(1, 1));
  });

  it('searches by title and filters all / allowed / not allowed', async () => {
    stubApi(routes());
    render();
    await openProducts();
    const box = screen.getByRole('searchbox', { name: t('web.rs_products_search') });
    fireEvent.change(box, { target: { value: 'ب' } });
    expect(chip('پلن ب')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'پلن الف' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'ویژه' })).toBeNull();
    fireEvent.change(box, { target: { value: '' } });

    fireEvent.click(screen.getByRole('button', { name: t('web.rs_filter_allowed') }));
    expect(chip('پلن الف')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'پلن ب' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('web.rs_filter_denied') }));
    expect(chip('پلن ب')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'پلن الف' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('web.rs_filter_all') }));
    expect(chip('پلن الف')).toBeInTheDocument();
  });

  it('opens the imported group when a search needs it', async () => {
    stubApi(routes());
    render();
    await openProducts();
    fireEvent.change(screen.getByRole('searchbox', { name: t('web.rs_products_search') }), {
      target: { value: 'قدیمی' },
    });
    expect(chip('قدیمی یک')).toBeInTheDocument();
  });

  it('saves through the existing grants route, with the catalogue override only', async () => {
    const api = stubApi(routes());
    render();
    await openProducts();
    const save = screen.getByRole('button', { name: t('web.rs_products_save') });
    expect(save).toBeDisabled();
    fireEvent.click(chip('پلن ب'));
    expect(screen.getByText(t('web.unsaved_changes'))).toBeInTheDocument();
    fireEvent.click(save);
    await waitFor(() => expect(posts(api, `/resellers/${CUSTOMER_ID}/grants`)).toHaveLength(1));
    const body = posts(api, `/resellers/${CUSTOMER_ID}/grants`)[0]?.body as Record<string, unknown>;
    expect(body['overrides']).toEqual([
      {
        dimension: 'CATALOGUE',
        grants: [
          { kind: 'PRODUCT', subject: P1 },
          { kind: 'PRODUCT', subject: P2 },
        ],
      },
    ]);
    expect(typeof body['idempotencyKey']).toBe('string');
  });

  it('asks before the standing closes over an unsaved product choice', async () => {
    stubApi(routes());
    render();
    await openProducts();
    fireEvent.click(chip('پلن ب'));
    fireEvent.click(
      within(document.getElementById('reseller-standing') as HTMLElement).getByRole('button', {
        name: t('web.close'),
      }),
    );
    expect(screen.getByRole('alertdialog', { name: t('web.unsaved_title') })).toBeInTheDocument();
  });

  it('draws read-only chips without resellers.edit', async () => {
    const api = stubApi(routes());
    render({ mayEdit: false });
    await openProducts();
    expect(chip('پلن الف')).toBeDisabled();
    expect(screen.queryByRole('button', { name: t('web.rs_products_save') })).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(api.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('asks for no products and names the key without catalog.view', async () => {
    const api = stubApi(routes());
    render({ mayViewCatalog: false });
    await openStanding();
    await openResellerTab('products');
    expect(await screen.findByText(t('web.reseller_policy_products_denied'))).toBeInTheDocument();
    expect(api.calls.filter((call) => call.url.includes('/products'))).toHaveLength(0);
  });
});

describe('the catalogue grants a product choice becomes', () => {
  const asPolicy = (effective: readonly Record<string, unknown>[]) =>
    policy(effective) as unknown as ResellerPolicy;
  const rows = products.map((one) => one as unknown as ProductSummaryResponse);
  const ids = (list: readonly string[]) => new Set(list);

  it('reads a product granted by itself, by its category, or by "every product"', () => {
    expect([...allowedIdsOf(asPolicy([{ kind: 'PRODUCT', subject: P1 }]), rows)]).toEqual([P1]);
    expect(
      [...allowedIdsOf(asPolicy([{ kind: 'CATEGORY', subject: CAT_A }]), rows)].sort(),
    ).toEqual([P1, P2]);
    expect(allowedIdsOf(asPolicy([{ kind: 'PRODUCT', subject: null }]), rows).size).toBe(5);
  });

  it('keeps a category grant that still covers only wanted products, and names the rest', () => {
    const current = asPolicy([{ kind: 'CATEGORY', subject: CAT_A }]);
    expect(catalogueGrantsFor(current, rows, ids([P1, P2, P3]))).toEqual({
      grants: [
        { kind: 'CATEGORY', subject: CAT_A },
        { kind: 'PRODUCT', subject: P3 },
      ],
    });
    // One product of the category off: the category grant would allow it, so it is dropped.
    expect(catalogueGrantsFor(current, rows, ids([P1, P3]))).toEqual({
      grants: [
        { kind: 'PRODUCT', subject: P1 },
        { kind: 'PRODUCT', subject: P3 },
      ],
    });
  });

  it('keeps "every product" only while every product stays wanted', () => {
    const current = asPolicy([{ kind: 'PRODUCT', subject: null }]);
    expect(catalogueGrantsFor(current, rows, ids([P1, P2, P3, L1, L2]))).toEqual({
      grants: [{ kind: 'PRODUCT', subject: null }],
    });
    expect(catalogueGrantsFor(current, rows, ids([P1]))).toEqual({
      grants: [{ kind: 'PRODUCT', subject: P1 }],
    });
  });

  it('puts the imported products in one group of their own, last', () => {
    const groups = groupProducts(rows, [
      { id: CAT_A, name: 'عمومی', emoji: null },
      { id: CAT_B, name: 'ویژه', emoji: null },
    ] as never);
    expect(groups.map((one) => [one.title, one.legacy, one.products.length])).toEqual([
      ['عمومی', false, 2],
      ['ویژه', false, 1],
      ['محصولات قدیمی', true, 2],
    ]);
  });
});
