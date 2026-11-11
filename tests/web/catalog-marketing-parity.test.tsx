import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { API_PREFIX, GIFT_CARD_ROUTES, type GiftCardBatchWire } from '@nexa/contracts';
import { ProductDetailPage, ProductsPage } from '../../apps/web/src/pages/products';
import { ProductCategoriesPage } from '../../apps/web/src/pages/product-categories';
import { ServiceLocationsPage } from '../../apps/web/src/pages/service-locations';
import { CustomServicePage } from '../../apps/web/src/pages/custom-service';
import { ExtraDevicesPage } from '../../apps/web/src/pages/extra-devices';
import { TrialsPage } from '../../apps/web/src/pages/trials';
import { DiscountsPage } from '../../apps/web/src/pages/discounts';
import { CampaignsPage } from '../../apps/web/src/pages/campaigns';
import { BroadcastsPage } from '../../apps/web/src/pages/broadcasts';
import { GiftCardsPage } from '../../apps/web/src/pages/gift-cards';
import { RemindersPage } from '../../apps/web/src/pages/reminders';
import { ReferralsPage } from '../../apps/web/src/pages/referrals';
import { RangePicker } from '../../apps/web/src/pages/business';
import { t } from '../../apps/web/src/i18n/web.fa';
import { categoryListing, panel, product, renderPage, stubApi } from './harness';
import { openFilterPanel } from './ui-helpers';

/**
 * Demo parity, PR-3 (catalogue and marketing): every element the owner's diff report listed
 * as «only in the demo» is asserted here, and every «only in the app» one is asserted absent.
 * Removing a restored element — a tab, a column, a framed box, a row «ویرایش», a section
 * heading, the «بیشتر» menu, a filter panel — fails a case below (the PR's mutation checks
 * name which). Nothing here touches what a button calls: the money pages (discounts, gift
 * cards) keep their own suites, which still pass unchanged apart from the layout lines.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const PRODUCT_ID = '019220ab-cdef-7012-8345-6789abcdef01';
const PANEL_ID = String(panel()['id']);

// ---------------------------------------------------------------------------
// /products and /products/:id
// ---------------------------------------------------------------------------

const productRoutes = [
  { url: `/products/${PRODUCT_ID}`, body: { product: product() } },
  { url: '/products', body: { products: [product()], nextCursor: null } },
  { url: '/panels', body: { panels: [panel()], nextCursor: null } },
  { url: '/product-categories', body: { categories: [categoryListing()] } },
];

describe('/products', () => {
  it('has real tabs «محصولات جاری / آرشیو» and no chip row', async () => {
    stubApi(productRoutes);
    window.history.replaceState(null, '', '/products');
    renderPage(
      <ProductsPage
        route={{ path: '/products', query: new URLSearchParams() }}
        mayEdit
        denied={false}
      />,
    );
    await screen.findByText('پلن یک‌ماهه');
    const tabs = screen.getByRole('tablist');
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual([t('web.products_view_current'), t('web.products_view_archive')]);
    expect(screen.queryByRole('button', { name: t('web.products_view_current') })).toBeNull();
  });

  it('draws the «در فهرست ربات» column, apart from the status column', async () => {
    stubApi(productRoutes);
    window.history.replaceState(null, '', '/products');
    renderPage(
      <ProductsPage
        route={{ path: '/products', query: new URLSearchParams() }}
        mayEdit
        denied={false}
      />,
    );
    await screen.findByText('پلن یک‌ماهه');
    const headers = screen.getAllByRole('columnheader').map((cell) => cell.textContent);
    expect(headers).toContain('در فهرست ربات');
    const row = screen.getByText('پلن یک‌ماهه').closest('tr') as HTMLElement;
    const cell = within(row).getByText(t('web.product_in_catalogue')).closest('td') as HTMLElement;
    expect(cell.getAttribute('data-label')).toBe('در فهرست ربات');
  });
});

describe('/products/:id', () => {
  it('puts «دسته و وضعیت» in a framed «عملیات» box, with the same buttons', async () => {
    stubApi(productRoutes);
    renderPage(<ProductDetailPage id={PRODUCT_ID} mayEdit denied={false} />);
    const panelBox = (await screen.findByRole('heading', { name: 'عملیات', level: 2 })).closest(
      'section',
    ) as HTMLElement;
    expect(panelBox.className).toContain('action-panel');
    const group = within(panelBox).getByRole('group', { name: 'دسته و وضعیت' });
    expect(
      within(group).getByRole('button', { name: t('web.product_category_assign') }),
    ).toBeTruthy();
    expect(within(group).getByRole('button', { name: t('web.product_deactivate') })).toBeTruthy();
  });

  it('draws no box for a role that may not edit', async () => {
    stubApi(productRoutes);
    renderPage(<ProductDetailPage id={PRODUCT_ID} mayEdit={false} denied={false} />);
    await screen.findByText(t('web.product_edit_denied'));
    expect(screen.queryByRole('heading', { name: 'عملیات' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// /product-categories and /service-locations
// ---------------------------------------------------------------------------

const category = (overrides: Record<string, unknown> = {}) =>
  categoryListing({ name: 'اشتراک استاندارد', productCount: 2, ...overrides });

describe('/product-categories', () => {
  const draw = (mayEdit = true) => {
    stubApi([
      {
        url: '/product-categories',
        body: {
          categories: [
            category(),
            category({
              id: '01a05e35-c9ad-7e93-bef3-1ed9b55292cb',
              name: 'پلن‌های قدیمی',
              status: 'INACTIVE',
            }),
          ],
        },
      },
    ]);
    renderPage(<ProductCategoriesPage denied={false} mayEdit={mayEdit} />);
  };

  it('has no count in the h1, and the name is text, not a button', async () => {
    draw();
    const h1 = await screen.findByRole('heading', { level: 1 });
    expect(h1.textContent).toBe(t('web.categories_title'));
    expect(screen.queryByRole('button', { name: 'اشتراک استاندارد' })).toBeNull();
  });

  it('has a «ویرایش» button on every row that opens the form', async () => {
    draw();
    const row = (await screen.findByText('اشتراک استاندارد')).closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'ویرایش' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('keeps the status filter in the «فیلترها» panel, not in a chip row', async () => {
    draw();
    await screen.findByText('اشتراک استاندارد');
    expect(screen.queryByRole('button', { name: t('web.category_inactive') })).toBeNull();
    const panelBox = openFilterPanel();
    fireEvent.click(
      within(panelBox).getByRole('button', { name: new RegExp(t('web.category_inactive')) }),
    );
    await waitFor(() => expect(screen.queryByText('اشتراک استاندارد')).toBeNull());
    expect(screen.getByText('پلن‌های قدیمی')).toBeTruthy();
  });
});

describe('/service-locations', () => {
  const location = (overrides: Record<string, unknown> = {}) => ({
    id: '019250ab-cdef-7012-8345-6789abcdef92',
    panelId: PANEL_ID,
    productId: null,
    locationKey: 'nl-1',
    label: 'هلند',
    initial: false,
    enabled: true,
    priceAmount: '0',
    priceCurrency: 'IRT',
    cooldownHours: null,
    maxChanges: null,
    periodDays: null,
    sortOrder: 0,
    version: 1,
    createdAt: '2026-09-10T12:30:00.000Z',
    updatedAt: '2026-09-11T12:30:00.000Z',
    ...overrides,
  });
  const draw = () => {
    stubApi([
      {
        url: '/service-locations',
        body: {
          locations: [
            location(),
            location({
              id: '019250ab-cdef-7012-8345-6789abcdef93',
              label: 'آلمان',
              enabled: false,
            }),
          ],
        },
      },
      { url: '/panels', body: { panels: [panel()], nextCursor: null } },
      { url: '/products', body: { products: [product()], nextCursor: null } },
    ]);
    renderPage(<ServiceLocationsPage denied={false} mayEdit />);
  };

  it('has no count in the h1 and a «ویرایش» button per row', async () => {
    draw();
    const row = (await screen.findByText('هلند', { selector: 'td *, td' })).closest(
      'tr',
    ) as HTMLElement;
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      t('web.service_locations_title'),
    );
    expect(screen.queryByRole('button', { name: 'هلند' })).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'ویرایش' }));
    expect(
      await screen.findByRole('dialog', { name: t('web.service_locations_editing') }),
    ).toBeTruthy();
  });

  it('keeps the target filter in the «فیلترها» panel', async () => {
    draw();
    await screen.findByText('هلند', { selector: 'td *, td' });
    expect(
      screen.queryByRole('button', { name: t('web.service_locations_target_off') }),
    ).toBeNull();
    fireEvent.click(
      within(openFilterPanel()).getByRole('button', {
        name: new RegExp(t('web.service_locations_target_off')),
      }),
    );
    await waitFor(() => expect(screen.queryByText('هلند', { selector: 'td *, td' })).toBeNull());
  });
});

// ---------------------------------------------------------------------------
// /custom-service and /extra-devices
// ---------------------------------------------------------------------------

const TIER_ID = '019290ab-cdef-7012-8345-6789abcdef01';
const rule = (overrides: Record<string, unknown> = {}) => ({
  id: '0192a0ab-cdef-7012-8345-6789abcdef01',
  dimension: 'VOLUME',
  label: 'حجم عمومی',
  minimum: '10',
  maximum: '100',
  unitPriceAmount: '2000',
  currency: 'IRT',
  customerId: null,
  resellerTierId: TIER_ID,
  panelId: PANEL_ID,
  enabled: true,
  createdAt: '2026-09-01T08:00:00.000Z',
  updatedAt: '2026-09-02T08:00:00.000Z',
  ...overrides,
});

describe('/custom-service', () => {
  const draw = () => {
    stubApi([
      { url: '/custom-service/rules', body: { rules: [rule()], rule: rule() } },
      {
        url: '/custom-service/locations',
        body: {
          locations: [
            {
              panelId: PANEL_ID,
              panelName: 'Frankfurt A',
              label: '🇩🇪 آلمان',
              enabled: true,
              createdAt: '2026-09-01T08:00:00.000Z',
              updatedAt: '2026-09-02T08:00:00.000Z',
            },
          ],
          location: null,
        },
      },
      { url: '/panels', body: { panels: [panel()], nextCursor: null } },
      {
        url: '/reseller-tiers',
        body: {
          tiers: [
            {
              id: TIER_ID,
              name: 'Gold',
              pricingMode: 'PERCENTAGE_DISCOUNT',
              discountPercentage: 20,
              creditLimit: { amount: '100000', currency: 'IRT' },
              grants: [],
              resellerCount: 1,
              monthlyMinimum: null,
              createdAt: '2026-09-01T08:00:00.000Z',
              updatedAt: '2026-09-01T08:00:00.000Z',
            },
          ],
        },
      },
    ]);
    renderPage(<CustomServicePage denied={false} mayEdit mayViewPanels mayViewTiers />);
  };

  it('splits «نوع قاعده», «عنوان» and «مخاطب» into their own columns', async () => {
    draw();
    const table = await screen.findByRole('table', { name: t('web.custom_service_rules_title') });
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((cell) => cell.textContent);
    expect(headers).toEqual(expect.arrayContaining(['نوع قاعده', 'عنوان', 'مخاطب']));
    expect(headers).not.toContain('نوع قاعده / عنوان');
    expect(headers).not.toContain('مخاطب / پنل');
  });

  it('has «ویرایش» on every rule and location row, and the name is text', async () => {
    draw();
    const rulesTable = await screen.findByRole('table', {
      name: t('web.custom_service_rules_title'),
    });
    const row = within(rulesTable).getByText('حجم عمومی').closest('tr') as HTMLElement;
    expect(screen.queryByRole('button', { name: 'حجم عمومی' })).toBeNull();
    expect(screen.queryByRole('button', { name: '🇩🇪 آلمان' })).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'ویرایش' }));
    expect(await screen.findByLabelText(/عنوان/u)).toBeTruthy();
    const locRow = screen.getByText('🇩🇪 آلمان').closest('tr') as HTMLElement;
    expect(within(locRow).getByRole('button', { name: 'ویرایش' })).toBeTruthy();
  });

  it('shows «ترتیب انتخاب قاعده» as a section heading, open', async () => {
    draw();
    await screen.findByRole('table', { name: t('web.custom_service_rules_title') });
    const heading = screen.getByRole('heading', { name: 'ترتیب انتخاب قاعده' });
    expect(heading.closest('details')).toBeNull();
    expect(
      within(heading.closest('section') as HTMLElement).getAllByRole('listitem').length,
    ).toBeGreaterThan(0);
  });
});

describe('/extra-devices', () => {
  it('has a «ویرایش» button per row and the title is text', async () => {
    stubApi([
      {
        url: '/service-addons?',
        body: {
          addons: [
            {
              id: '019250ab-cdef-7012-8345-6789abcdef77',
              kind: 'ADD_DEVICES',
              title: 'هر کاربر اضافه',
              status: 'ACTIVE',
              sortOrder: 0,
              trafficBytes: null,
              durationDays: null,
              maxQuantity: 3,
              panelId: null,
              productId: null,
              version: 2,
              priceAmount: '50000',
              priceCurrency: 'IRT',
              createdAt: '2026-09-10T12:30:00.000Z',
              updatedAt: '2026-09-11T12:30:00.000Z',
            },
          ],
          nextCursor: null,
        },
      },
      { url: '/panels', body: { panels: [panel()], nextCursor: null } },
      { url: '/products', body: { products: [product()], nextCursor: null } },
    ]);
    renderPage(<ExtraDevicesPage denied={false} mayEdit mayViewPanels />);
    const row = (await screen.findByText('هر کاربر اضافه', { selector: 'td *, td' })).closest(
      'tr',
    ) as HTMLElement;
    expect(screen.queryByRole('button', { name: 'هر کاربر اضافه' })).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'ویرایش' }));
    expect(
      await screen.findByRole('dialog', { name: t('web.extra_devices_editing') }),
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// /trials
// ---------------------------------------------------------------------------

describe('/trials', () => {
  it('keeps the per-panel state filter in the «فیلترها» panel, not in a chip row', async () => {
    const trial = (overrides: Record<string, unknown>) => ({
      panelId: 'a',
      enabled: true,
      trafficBytes: '104857600',
      durationHours: 72,
      label: null,
      revision: 1,
      updatedAt: '2026-09-29T10:00:00.000Z',
      ...overrides,
    });
    stubApi([
      {
        url: '/trials/panels',
        body: {
          panels: [
            { panelId: 'a', panelName: 'Rick', trial: trial({ panelId: 'a' }), offeredNow: true },
            {
              panelId: 'b',
              panelName: 'Off',
              trial: trial({ panelId: 'b', enabled: false }),
              offeredNow: false,
            },
          ],
        },
      },
      { url: '/trials/overrides', body: { overrides: [], nextCursor: null } },
      { url: '/trials/resets', body: { resets: [], nextCursor: null } },
    ]);
    renderPage(<TrialsPage mayViewOverrides mayReset={false} mayViewHistory mayViewPanels />);
    await screen.findByText('Rick');
    expect(
      screen.queryByRole('button', { name: new RegExp(t('web.trials_panel_disabled')) }),
    ).toBeNull();
    fireEvent.click(
      within(openFilterPanel()).getByRole('button', {
        name: new RegExp(t('web.trials_panel_disabled')),
      }),
    );
    await waitFor(() => expect(screen.queryByText('Rick')).toBeNull());
    expect(screen.getByText('Off')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// /discounts (money page: layout only, nothing a button calls moved)
// ---------------------------------------------------------------------------

describe('/discounts', () => {
  const discount = {
    id: '019250ab-cdef-7012-8345-6789abcdef01',
    kind: 'CODE',
    code: 'SUMMER25',
    label: 'تخفیف مهر',
    type: 'PERCENTAGE',
    value: '25',
    currency: null,
    appliesTo: ['NEW_SERVICE'],
    productId: null,
    categoryId: null,
    customerId: null,
    firstPurchaseOnly: false,
    minimumSubtotalAmount: null,
    startsAt: null,
    endsAt: null,
    totalRedemptionsLimit: 100,
    perCustomerLimit: 1,
    priority: 50,
    stackable: false,
    status: 'INACTIVE',
    liveRedemptions: 3,
    createdAt: '2026-09-01T08:00:00.000Z',
    updatedAt: '2026-09-02T08:00:00.000Z',
  };
  const cashback = {
    id: '019260ab-cdef-7012-8345-6789abcdef01',
    label: 'کش‌بک نوروز',
    percent: 5,
    appliesTo: ['NEW_SERVICE'],
    productId: null,
    categoryId: null,
    startsAt: null,
    endsAt: null,
    status: 'ACTIVE',
    createdAt: '2026-09-01T08:00:00.000Z',
    updatedAt: '2026-09-02T08:00:00.000Z',
  };
  const draw = (props: { mayEditDiscounts?: boolean; mayEditCashback?: boolean } = {}) => {
    stubApi([
      { url: '/discounts', body: { discounts: [discount], nextCursor: null } },
      { url: '/cashback-rules', body: { rules: [cashback], nextCursor: null } },
    ]);
    renderPage(<DiscountsPage denied={false} mayEditDiscounts mayEditCashback {...props} />);
  };

  it('stacks the sections on one page instead of tabs', async () => {
    draw();
    await screen.findByText('تخفیف مهر');
    expect(screen.queryByRole('tab')).toBeNull();
    for (const name of ['قاعده‌های تخفیف', 'قاعده‌های کش‌بک', 'پیش‌نمایش قیمت']) {
      expect(screen.getByRole('heading', { name })).toBeTruthy();
    }
    expect(screen.getByText('کش‌بک نوروز')).toBeTruthy();
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toContain(
      'درصد کش‌بک',
    );
  });

  it('draws the price preview form with its four fields and «محاسبه»', async () => {
    draw();
    await screen.findByText('تخفیف مهر');
    for (const label of ['نوع سفارش', 'محصول', 'شناسهٔ مشتری', 'کد تخفیف']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getByRole('button', { name: 'محاسبه' })).toBeTruthy();
  });

  it('shows «قاعده‌هایی که این صفحه رعایت می‌کند» as a heading with its rules, not a fold', async () => {
    draw();
    await screen.findByText('تخفیف مهر');
    const heading = screen.getByRole('heading', { name: 'قاعده‌هایی که این صفحه رعایت می‌کند' });
    expect(heading.closest('details')).toBeNull();
    const block = heading.closest('section') as HTMLElement;
    expect(within(block).getByText(t('web.discounts_rule_no_delete'))).toBeTruthy();
  });

  it('has a text «ویرایش» button on a discount and a cashback row, and the name is text', async () => {
    draw();
    const row = (await screen.findByText('تخفیف مهر')).closest('tr') as HTMLElement;
    expect(screen.queryByRole('button', { name: 'تخفیف مهر' })).toBeNull();
    expect(within(row).getByRole('button', { name: 'ویرایش' }).textContent).toContain('ویرایش');
    // The activation command keeps its own button, beside it.
    expect(within(row).getByRole('button', { name: t('web.rule_activate') })).toBeTruthy();
    const cbRow = screen.getByText('کش‌بک نوروز').closest('tr') as HTMLElement;
    expect(within(cbRow).getByRole('button', { name: 'ویرایش' })).toBeTruthy();
  });

  it('draws no «ویرایش» for a role without the key', async () => {
    draw({ mayEditDiscounts: false, mayEditCashback: false });
    const row = (await screen.findByText('تخفیف مهر')).closest('tr') as HTMLElement;
    expect(within(row).queryByRole('button', { name: 'ویرایش' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// /campaigns and /broadcasts
// ---------------------------------------------------------------------------

describe('/campaigns', () => {
  const summary = {
    id: '019310ab-cdef-7012-8345-6789abcdef01',
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
  };
  const draw = (query = '') => {
    stubApi([
      {
        url: '/campaigns',
        body: {
          campaigns: [summary],
          nextCursor: null,
          presentation: { timezone: 'Asia/Tehran', calendar: 'jalali' },
        },
      },
    ]);
    renderPage(
      <CampaignsPage
        route={{ path: '/campaigns', query: new URLSearchParams(query) }}
        denied={false}
        mayManage
      />,
    );
  };

  it('has its own «اقدامات» column holding the action kinds', async () => {
    draw();
    const row = (await screen.findByText('جشنواره پاییز')).closest('tr') as HTMLElement;
    const headers = screen.getAllByRole('columnheader').map((cell) => cell.textContent);
    expect(headers).toContain('اقدامات');
    const cell = within(row)
      .getAllByRole('cell')
      .find((c) => c.getAttribute('data-label') === 'اقدامات');
    expect(cell?.textContent).toContain(t('web.campaign_action_discount'));
    // The name's cell no longer carries the kinds under it.
    const nameCell = within(row)
      .getAllByRole('cell')
      .find((c) => c.getAttribute('data-label') === t('web.campaign_name'));
    expect(nameCell?.textContent).not.toContain(t('web.campaign_action_discount'));
  });

  it('has the page-head «بیشتر» menu and a «فیلترها» panel instead of the chip row', async () => {
    draw();
    await screen.findByText('جشنواره پاییز');
    fireEvent.click(screen.getByRole('button', { name: 'بیشتر' }));
    expect(screen.getByRole('menuitem', { name: t('web.nc_reread') })).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: t('web.campaign_state_draft') })).toBeNull();
    expect(
      within(openFilterPanel()).getByRole('button', { name: t('web.campaign_state_draft') }),
    ).toBeTruthy();
  });
});

describe('/broadcasts', () => {
  it('has the «نوع پیام» column apart from the title', async () => {
    stubApi([
      {
        url: '/broadcasts',
        body: {
          broadcasts: [
            {
              id: '019280ab-cdef-7012-8345-6789abcdef01',
              title: 'Nowruz',
              state: 'DRAFT',
              pauseReason: null,
              contentKind: 'TEXT',
              body: 'سلام',
              buttons: [],
              media: null,
              purpose: 'MARKETING',
              source: null,
              sourceVerifiedAt: null,
              pin: false,
              frozenAudienceId: null,
              audience: { version: 1, customerStatus: 'ACTIVE', purchase: 'PURCHASED' },
              audienceHash: 'a'.repeat(64),
              audienceAsOf: null,
              recipientCount: null,
              fingerprint: null,
              scheduledAt: null,
              counts: {
                total: 0,
                pending: 0,
                sending: 0,
                sent: 0,
                unconfirmed: 0,
                failed: 0,
                unreachable: 0,
                skipped: 0,
                cancelled: 0,
                pinned: 0,
                pinFailed: 0,
              },
              progressPercent: null,
              version: 3,
              createdBy: { id: 'x', username: 'owner' },
              launchedBy: null,
              createdAt: '2026-09-20T10:00:00.000Z',
              launchedAt: null,
              startedAt: null,
              completedAt: null,
              cancelledAt: null,
            },
          ],
          nextCursor: null,
          presentation: { timezone: 'Asia/Tehran', calendar: 'jalali' },
        },
      },
    ]);
    renderPage(
      <BroadcastsPage
        route={{ path: '/broadcasts', query: new URLSearchParams() }}
        denied={false}
        maySend
      />,
    );
    const row = (await screen.findByText('Nowruz')).closest('tr') as HTMLElement;
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toContain(
      'نوع پیام',
    );
    const kind = within(row)
      .getAllByRole('cell')
      .find((c) => c.getAttribute('data-label') === 'نوع پیام');
    expect(kind?.textContent).toBe(t('web.bc_kind_text'));
  });
});

// ---------------------------------------------------------------------------
// /gift-cards and /reminders: the «بیشتر» menu
// ---------------------------------------------------------------------------

describe('the page-head «بیشتر» menu', () => {
  it('is on /gift-cards, and its one item re-reads the list (nothing that writes moved in)', async () => {
    const batch: GiftCardBatchWire = {
      id: '0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b',
      label: 'نوروز',
      amount: { amountMinor: '50000', currency: 'IRT' },
      count: 10,
      perCustomerLimit: 1,
      expiresAt: '2027-03-20T20:30:00.000Z',
      state: 'ACTIVE',
      createdAt: '2026-10-26T08:00:00.000Z',
      createdByAdminId: null,
      disabledAt: null,
      redeemedCount: 3,
      disabledCount: 0,
      unredeemedCount: 7,
      redeemedTotal: { amountMinor: '150000', currency: 'IRT' },
      exportAvailableUntil: null,
    };
    const api = stubApi([
      {
        url: `${API_PREFIX}${GIFT_CARD_ROUTES.batches}`,
        body: { batches: [batch], nextCursor: null, walletCurrency: 'IRT', enabled: true },
        method: 'GET',
      },
    ]);
    renderPage(<GiftCardsPage denied={false} mayCreate mayExport={false} mayDisable />);
    await screen.findByText('نوروز');
    const before = api.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'بیشتر' }));
    const items = screen.getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual([t('web.nc_reread')]);
    fireEvent.click(items[0] as HTMLElement);
    await waitFor(() => expect(api.calls.length).toBeGreaterThan(before));
    expect(api.calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('is on /reminders, and its one item re-reads the settings and flags', async () => {
    const api = stubApi([
      { url: '/settings', body: { settings: [] } },
      { url: '/features', body: { flags: [] } },
      { url: '/templates', body: { templates: [] } },
    ]);
    renderPage(<RemindersPage mayEdit denied={false} mayViewTemplates mayEditTemplates />);
    await waitFor(() => expect(api.calls.length).toBeGreaterThan(0));
    const reads = () => api.calls.filter((call) => call.url.endsWith('/features')).length;
    await waitFor(() => expect(reads()).toBeGreaterThan(0));
    const before = reads();
    fireEvent.click(screen.getByRole('button', { name: 'بیشتر' }));
    const items = screen.getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual([t('web.nc_reread')]);
    fireEvent.click(items[0] as HTMLElement);
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });
});

// ---------------------------------------------------------------------------
// /referrals
// ---------------------------------------------------------------------------

describe('/referrals', () => {
  const draw = () => {
    stubApi([
      { url: '/referrals', body: { referrals: [], nextCursor: null } },
      { url: '/referral-commissions', body: { commissions: [], nextCursor: null } },
    ]);
    renderPage(
      <ReferralsPage
        route={{ path: '/referrals', query: new URLSearchParams() }}
        denied={false}
        mayViewBanner={false}
        mayEditBanner={false}
      />,
    );
  };

  it('shows «قاعده‌هایی که این صفحه رعایت می‌کند» as a heading with its rules, not a fold', async () => {
    draw();
    const heading = await screen.findByRole('heading', {
      name: 'قاعده‌هایی که این صفحه رعایت می‌کند',
    });
    expect(heading.closest('details')).toBeNull();
    const block = heading.closest('section') as HTMLElement;
    expect(within(block).getByText(t('web.referrals_rule_read_only'))).toBeTruthy();
  });

  it('keeps the commission state filter in the «فیلترها» panel, not in a chip row', async () => {
    draw();
    await screen
      .findByRole('table', { name: t('web.referrals_commissions_title') })
      .catch(() => undefined);
    await screen.findByRole('heading', { name: t('web.referrals_commissions_title') });
    expect(screen.queryByRole('button', { name: 'باطل شده' })).toBeNull();
    expect(within(openFilterPanel()).getByRole('button', { name: 'باطل شده' })).toBeTruthy();
  });
});

describe('the referral analytics period', () => {
  const route = { path: '/referrals', query: new URLSearchParams('range=THIS_MONTH') };

  it('is a filter in the «فیلترها» panel, not an always-visible chip row', () => {
    renderPage(
      <RangePicker
        route={route}
        selection={{ range: 'THIS_MONTH' }}
        inFilterPanel="LAST_30_DAYS"
      />,
    );
    expect(screen.queryByRole('button', { name: t('web.report_range_today') })).toBeNull();
    // A period that is not the default is an active filter chip.
    expect(screen.getByText(new RegExp(t('web.report_range_this_month')))).toBeTruthy();
    expect(
      within(openFilterPanel()).getByRole('button', { name: t('web.report_range_today') }),
    ).toBeTruthy();
  });

  it('keeps the chip row where the page does not ask for the panel (the reports page)', () => {
    renderPage(<RangePicker route={route} selection={{ range: 'THIS_MONTH' }} />);
    expect(screen.getByRole('button', { name: t('web.report_range_today') })).toBeTruthy();
  });
});
