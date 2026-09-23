import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { ResellersPage, percentOf } from '../../apps/web/src/pages/resellers';
import {
  ResellerTiersPage,
  blockedDimensions,
  grantsBodyFrom,
  grantsStateOf,
} from '../../apps/web/src/pages/reseller-tiers';
import { UserDetailPage } from '../../apps/web/src/pages/users';
import { OrderDetailPage } from '../../apps/web/src/pages/orders';
import { PLANNED_SURFACES } from '../../apps/web/src/pages/planned';
import { NAV, navPermitted, resolve } from '../../apps/web/src/app';
import {
  categoryListing,
  customer,
  order,
  panel,
  product,
  renderPage,
  stubApi,
  type Api,
} from './harness';

/**
 * WP9-B on the Web Admin: the Resellers page, the Tiers page and its grants editor, the
 * reseller card and the negative balance on a customer, and the reseller block on an
 * order's pricing card.
 *
 * Every response goes through the real client and the real zod schema, so a fixture that
 * drifts from `resellerSummarySchema`, `resellerTierSummarySchema` or
 * `orderPricingResponseSchema` fails here rather than in production. What these cases
 * hold is what the screen DOES: ask nothing without `resellers.view`, draw no form
 * without `resellers.edit`, send the grants body the server will read as intended — a
 * null subject for "all", nothing at all for "none" — and state a missing reseller row as
 * a fact about the customer rather than as an error.
 */

const CUSTOMER_ID = '019210ab-cdef-7012-8345-6789abcdef01';
const TIER_ID = '019290ab-cdef-7012-8345-6789abcdef01';
const OTHER_TIER_ID = '019290ab-cdef-7012-8345-6789abcdef02';
const PRODUCT_ID = product().id as string;
const PANEL_ID = panel().id as string;
const BOT_ID = '0192a0ab-cdef-7012-8345-6789abcdef01';
const ORDER_ID = '019230ab-cdef-7012-8345-6789abcdef01';

function tier(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TIER_ID,
    name: 'Gold',
    pricingMode: 'PERCENTAGE_DISCOUNT',
    discountPercentage: 10,
    creditLimit: { amount: '500000', currency: 'IRT' },
    grants: [],
    resellerCount: 2,
    createdAt: '2026-09-01T08:00:00.000Z',
    updatedAt: '2026-09-01T08:00:00.000Z',
    ...overrides,
  };
}

function reseller(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    customerId: CUSTOMER_ID,
    telegramUserId: '5551234567',
    displayName: 'Reza Reseller',
    tier: { id: TIER_ID, name: 'Gold' },
    status: 'ACTIVE',
    pricingMode: 'TIER',
    discountPercentage: null,
    creditLimit: null,
    effectiveCreditLimit: { amount: '500000', currency: 'IRT' },
    createdAt: '2026-09-02T08:00:00.000Z',
    updatedAt: '2026-09-02T08:00:00.000Z',
    ...overrides,
  };
}

const notFound = (code: string) => ({
  error: { kind: 'not_found', code, message: 'Not found.', correlationId: 't' },
});

const listRoutes = (
  rows: readonly Record<string, unknown>[] = [reseller()],
  tiers: readonly Record<string, unknown>[] = [tier()],
) => [
  { url: '/resellers', body: { resellers: rows, nextCursor: null } },
  { url: '/reseller-tiers', body: { tiers } },
];

const gets = (api: Api, path: string) =>
  api.calls.filter((call) => call.method === 'GET' && call.url.includes(path));
const posts = (api: Api, path: string) =>
  api.calls.filter((call) => call.method === 'POST' && call.url.includes(path));

const renderList = (options: { query?: string; denied?: boolean; mayEdit?: boolean } = {}) =>
  renderPage(
    <ResellersPage
      route={{ path: '/resellers', query: new URLSearchParams(options.query ?? '') }}
      denied={options.denied ?? false}
      mayEdit={options.mayEdit ?? true}
    />,
  );

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

describe('permission gating', () => {
  it('asks for nothing and says so without resellers.view', async () => {
    const api = stubApi(listRoutes());
    renderList({ denied: true });
    expect(await screen.findByText('شما به این بخش دسترسی ندارید.')).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
    // No form either: the tier picker and the edit both need the read.
    expect(screen.queryByRole('button', { name: 'ثبت نماینده' })).toBeNull();
  });

  it('draws no register form and no edit button without resellers.edit, and names the key', async () => {
    stubApi(listRoutes());
    renderList({ mayEdit: false });
    await screen.findByText('Reza Reseller');
    expect(screen.getByText(/resellers\.edit/u)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ثبت نماینده' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'ویرایش' })).toBeNull();
  });

  it('asks for no tier and draws no tier form without the keys', async () => {
    const api = stubApi(listRoutes());
    renderPage(
      <ResellerTiersPage denied mayEdit={false} mayViewCatalog={false} mayViewPanels={false} />,
    );
    expect(await screen.findByText('شما به این بخش دسترسی ندارید.')).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'ساخت سطح' })).toBeNull();
  });

  it('links both pages on resellers.view alone, and routes them to the live pages', async () => {
    for (const id of ['resellers', 'reseller-tiers']) {
      const entry = NAV.find((candidate) => candidate.id === id);
      expect(entry, id).toBeDefined();
      if (entry === undefined) return;
      expect(navPermitted(entry, ['resellers.view'])).toBe(true);
      expect(navPermitted(entry, ['resellers.edit'])).toBe(false);
      expect(navPermitted(entry, [])).toBe(false);
    }
    expect(PLANNED_SURFACES.map((surface) => surface.key)).not.toContain('resellers');

    stubApi(listRoutes());
    const resolved = resolve({ path: '/resellers', query: new URLSearchParams() }, [
      'resellers.view',
    ]);
    const view = renderPage(resolved.element as ReactElement);
    expect(await within(view.container).findByText('Reza Reseller')).toBeInTheDocument();
    expect(within(view.container).queryByText('چرا هنوز فعال نیست')).toBeNull();
    // A reader, derived at the route: no register form.
    expect(within(view.container).queryByRole('button', { name: 'ثبت نماینده' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

describe('the reseller list', () => {
  it('renders the name, Telegram id, tier, status, pricing and the limit that applies', async () => {
    stubApi(
      listRoutes([
        reseller(),
        reseller({
          customerId: '019210ab-cdef-7012-8345-6789abcdef02',
          telegramUserId: '5559876543',
          displayName: null,
          status: 'SUSPENDED',
          pricingMode: 'PERCENTAGE_DISCOUNT',
          discountPercentage: 15,
          creditLimit: { amount: '1000000', currency: 'IRT' },
          effectiveCreditLimit: { amount: '1000000', currency: 'IRT' },
        }),
      ]),
    );
    renderList();
    const table = await screen.findByRole('table', { name: 'فهرست نمایندگان' });
    const first = within(table).getByText('Reza Reseller').closest('tr') as HTMLElement;
    expect(within(first).getByText('Reza Reseller').closest('a')?.getAttribute('href')).toBe(
      `/users/${CUSTOMER_ID}`,
    );
    expect(first.textContent).toContain('5551234567');
    expect(first.textContent).toContain('Gold');
    expect(first.textContent).toContain('فعال');
    expect(first.textContent).toContain('مطابق سطح');
    expect(first.textContent).toContain('500,000');
    expect(first.textContent).toContain('از سطح');

    // No display name: the Telegram id IS the link.
    const second = within(table).getByText('5559876543').closest('tr') as HTMLElement;
    expect(second.textContent).toContain('معلق');
    expect(second.textContent).toContain('درصد اختصاصی کمتر از قیمت فهرست');
    expect(second.textContent).toContain('15');
    expect(second.textContent).toContain('1,000,000');
    expect(second.textContent).toContain('اختصاصی این نماینده');
  });

  it('filters on the server: the applied search, the status and the tier', async () => {
    const api = stubApi(listRoutes());
    renderList({ query: 'search=5551234567' });
    await screen.findByText('Reza Reseller');
    expect(gets(api, '/resellers?search=5551234567')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'معلق' }));
    await waitFor(() => expect(gets(api, 'status=SUSPENDED')).toHaveLength(1));

    fireEvent.change(screen.getByLabelText('سطح', { selector: '#resellers-tier' }), {
      target: { value: TIER_ID },
    });
    await waitFor(() => expect(gets(api, `tierId=${TIER_ID}`)).toHaveLength(1));
  });
});

// ---------------------------------------------------------------------------
// Register and edit
// ---------------------------------------------------------------------------

describe('registering and editing a reseller', () => {
  /*
   * The harness routes by URL and not by method, and `POST /resellers` shares its URL
   * with the list — so these two cases assert the REQUEST, which is what they are about.
   * The response-side behaviour of a write is asserted on the update below, whose URL is
   * its own.
   */
  it("registers with the tier's limit as a null, and an idempotency key in the body", async () => {
    const api = stubApi(listRoutes());
    renderList({ query: `register=${CUSTOMER_ID}` });
    await screen.findByText('Reza Reseller');
    // Handed over by the customer page's link, filled in.
    expect((screen.getByLabelText('شناسهٔ مشتری') as HTMLInputElement).value).toBe(CUSTOMER_ID);

    fireEvent.change(screen.getByLabelText('سطح', { selector: '#reseller-register-tier' }), {
      target: { value: TIER_ID },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ثبت نماینده' }));

    await waitFor(() => expect(posts(api, '/resellers')).toHaveLength(1));
    const body = posts(api, '/resellers')[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      customerId: CUSTOMER_ID,
      tierId: TIER_ID,
      pricingMode: 'TIER',
      discountPercentage: null,
      creditLimit: null,
    });
    expect(String(body['idempotencyKey']).length).toBeGreaterThanOrEqual(8);
  });

  it('sends its own limit and a percentage override when chosen', async () => {
    const api = stubApi(listRoutes());
    renderList();
    await screen.findByText('Reza Reseller');
    fireEvent.change(screen.getByLabelText('شناسهٔ مشتری'), { target: { value: CUSTOMER_ID } });
    fireEvent.change(screen.getByLabelText('سطح', { selector: '#reseller-register-tier' }), {
      target: { value: TIER_ID },
    });
    fireEvent.change(screen.getByLabelText('قیمت‌گذاری'), {
      target: { value: 'PERCENTAGE_DISCOUNT' },
    });
    // A percentage mode with no percentage is refused here, before any request.
    expect(screen.getByRole('button', { name: 'ثبت نماینده' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('درصد'), { target: { value: '12' } });
    fireEvent.click(screen.getByLabelText('سقف اعتبار اختصاصی'));
    fireEvent.change(screen.getByLabelText('سقف اعتبار (واحد خرد)'), {
      target: { value: '0750000' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ثبت نماینده' }));

    await waitFor(() => expect(posts(api, '/resellers')).toHaveLength(1));
    expect(posts(api, '/resellers')[0]?.body).toMatchObject({
      pricingMode: 'PERCENTAGE_DISCOUNT',
      discountPercentage: 12,
      creditLimit: { amount: '750000', currency: 'IRT' },
    });
  });

  it('edits status, tier and limit through the customer-addressed route', async () => {
    const api = stubApi([
      ...listRoutes([reseller()], [tier(), tier({ id: OTHER_TIER_ID, name: 'Silver' })]),
      { url: `/resellers/${CUSTOMER_ID}`, body: { reseller: reseller({ status: 'SUSPENDED' }) } },
    ]);
    renderList();
    await screen.findByText('Reza Reseller');
    fireEvent.click(screen.getByRole('button', { name: 'ویرایش' }));
    fireEvent.change(screen.getByLabelText('وضعیت'), { target: { value: 'SUSPENDED' } });
    fireEvent.change(screen.getByLabelText('سطح', { selector: '#reseller-update-tier' }), {
      target: { value: OTHER_TIER_ID },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));

    await waitFor(() => expect(posts(api, `/resellers/${CUSTOMER_ID}`)).toHaveLength(1));
    const body = posts(api, `/resellers/${CUSTOMER_ID}`)[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      status: 'SUSPENDED',
      tierId: OTHER_TIER_ID,
      pricingMode: 'TIER',
      discountPercentage: null,
      creditLimit: null,
    });
    // The customer is the ROUTE, never a body field on an update.
    expect(body['customerId']).toBeUndefined();
    // Answered: the form closes and the list is asked again.
    expect(await screen.findByText('نماینده ذخیره شد.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ثبت نماینده' })).toBeInTheDocument();
  });

  it("says a refusal in the operator's language, not the server's", async () => {
    stubApi([
      ...listRoutes(),
      {
        url: `/resellers/${CUSTOMER_ID}`,
        status: 404,
        body: notFound('commerce.reseller_tier_not_found'),
      },
    ]);
    renderList();
    await screen.findByText('Reza Reseller');
    fireEvent.click(screen.getByRole('button', { name: 'ویرایش' }));
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));
    expect(
      await screen.findByText('این سطح نمایندگی وجود ندارد؛ فهرست را تازه کنید.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Not found.')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tiers and the grants editor
// ---------------------------------------------------------------------------

describe('the grants body', () => {
  const none = grantsStateOf([]);

  it("sends one null-subject row for 'all' and nothing for 'none'", () => {
    const state = { ...none, OPERATION: { mode: 'ALL' as const, subjects: [], typed: '' } };
    expect(grantsBodyFrom(state, new Set())).toEqual({
      grants: [{ kind: 'OPERATION', subject: null }],
    });
    expect(grantsBodyFrom(none, new Set())).toEqual({ grants: [] });
  });

  it('sends the specific subjects, sorted and unique, in the contract order of kinds', () => {
    const state = {
      ...none,
      OPERATION: { mode: 'SOME' as const, subjects: ['RENEW', 'NEW_SERVICE', 'RENEW'], typed: '' },
      BOT: { mode: 'SOME' as const, subjects: [], typed: `${BOT_ID}\n\n${BOT_ID}` },
      PRODUCT: { mode: 'SOME' as const, subjects: [PRODUCT_ID], typed: '' },
    };
    expect(grantsBodyFrom(state, new Set(['BOT']))).toEqual({
      grants: [
        { kind: 'PRODUCT', subject: PRODUCT_ID },
        { kind: 'BOT', subject: BOT_ID },
        { kind: 'OPERATION', subject: 'NEW_SERVICE' },
        { kind: 'OPERATION', subject: 'RENEW' },
      ],
    });
  });

  it("refuses 'specific' with nothing chosen, and an id that is not one", () => {
    expect(
      grantsBodyFrom({ ...none, PANEL: { mode: 'SOME', subjects: [], typed: '' } }, new Set()),
    ).toEqual({ problem: 'web.reseller_grants_problem_empty' });
    expect(
      grantsBodyFrom(
        { ...none, BOT: { mode: 'SOME', subjects: [], typed: 'not-an-id' } },
        new Set(['BOT']),
      ),
    ).toEqual({ problem: 'web.reseller_grants_problem_id' });
  });

  it('reads a stored null subject as all, whatever else is beside it', () => {
    const state = grantsStateOf([
      { kind: 'PANEL', subject: PANEL_ID },
      { kind: 'PANEL', subject: null },
      { kind: 'PRODUCT', subject: PRODUCT_ID },
    ]);
    expect(state.PANEL.mode).toBe('ALL');
    expect(state.PRODUCT).toMatchObject({ mode: 'SOME', subjects: [PRODUCT_ID] });
    expect(state.BOT.mode).toBe('NONE');
  });

  it('names every dimension a tier still refuses, with product OR category for the catalogue', () => {
    const modes = {
      PRODUCT: 'NONE',
      CATEGORY: 'NONE',
      PANEL: 'NONE',
      BOT: 'NONE',
      OPERATION: 'NONE',
    } as const;
    expect(blockedDimensions(modes)).toEqual(['OPERATION', 'CATALOGUE', 'PANEL', 'BOT']);
    expect(blockedDimensions({ ...modes, CATEGORY: 'ALL', OPERATION: 'SOME' })).toEqual([
      'PANEL',
      'BOT',
    ]);
    expect(
      blockedDimensions({
        PRODUCT: 'SOME',
        CATEGORY: 'NONE',
        PANEL: 'ALL',
        BOT: 'ALL',
        OPERATION: 'ALL',
      }),
    ).toEqual([]);
  });
});

describe('the tiers page', () => {
  const pickers = [
    { url: '/products', body: { products: [product()], nextCursor: null } },
    { url: '/product-categories', body: { categories: [categoryListing()] } },
    { url: '/panels', body: { panels: [panel()], nextCursor: null } },
  ];

  const group = (label: string) =>
    screen
      .getAllByRole('group')
      .find((node) => node.querySelector('legend')?.textContent?.startsWith(label)) as HTMLElement;

  it('shows that a tier with no grants sells nothing, kind by kind', async () => {
    stubApi([{ url: '/reseller-tiers', body: { tiers: [tier()] } }]);
    renderPage(<ResellerTiersPage denied={false} mayEdit mayViewCatalog mayViewPanels />);
    const table = await screen.findByRole('table', { name: 'سطوح' });
    const row = within(table).getByText('Gold').closest('tr') as HTMLElement;
    // Five kinds, each drawn as the refusal it is, and the consequence in words.
    expect(within(row).getAllByText('هیچ')).toHaveLength(5);
    expect(row.textContent).toContain('این سطح فعلاً اجازهٔ هیچ خریدی نمی‌دهد.');
    expect(row.textContent).toContain('500,000');
    expect(row.textContent).toContain('10');
  });

  it("saves 'all' as a null subject and ticked subjects by id, and nothing for 'none'", async () => {
    const api = stubApi([
      { url: '/reseller-tiers', body: { tiers: [tier()] } },
      ...pickers,
      { url: `/reseller-tiers/${TIER_ID}/grants`, body: { tier: tier() } },
    ]);
    renderPage(<ResellerTiersPage denied={false} mayEdit mayViewCatalog mayViewPanels />);
    await screen.findByText('Gold');
    fireEvent.click(screen.getByRole('button', { name: 'مجوزها' }));

    // Deny-by-default, visible before anything is chosen.
    expect(
      await screen.findByText(/با این مجوزها نماینده‌ای در این سطح هیچ خریدی/u),
    ).toBeInTheDocument();

    fireEvent.click(within(group('نوع خرید')).getByLabelText('همه'));
    fireEvent.click(within(group('پنل')).getByLabelText('همه'));
    fireEvent.click(within(group('محصول')).getByLabelText('موارد مشخص'));
    fireEvent.click(await within(group('محصول')).findByLabelText('پلن یک‌ماهه'));
    fireEvent.click(within(group('ربات')).getByLabelText('موارد مشخص'));
    fireEvent.change(within(group('ربات')).getByLabelText('شناسه‌ها'), {
      target: { value: BOT_ID },
    });

    // Every dimension is open now; the category stays NONE and the product carries it.
    expect(screen.queryByText(/با این مجوزها نماینده‌ای در این سطح هیچ خریدی/u)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'ذخیرهٔ مجوزها' }));
    await waitFor(() => expect(posts(api, '/grants')).toHaveLength(1));
    const body = posts(api, '/grants')[0]?.body as Record<string, unknown>;
    expect(body['grants']).toEqual([
      { kind: 'PRODUCT', subject: PRODUCT_ID },
      { kind: 'PANEL', subject: null },
      { kind: 'BOT', subject: BOT_ID },
      { kind: 'OPERATION', subject: null },
    ]);
    expect(String(body['idempotencyKey']).length).toBeGreaterThanOrEqual(8);
  });

  it('takes typed ids and asks for no list the actor may not read', async () => {
    const api = stubApi([
      {
        url: '/reseller-tiers',
        body: { tiers: [tier({ grants: [{ kind: 'PRODUCT', subject: PRODUCT_ID }] })] },
      },
      ...pickers,
    ]);
    renderPage(
      <ResellerTiersPage denied={false} mayEdit mayViewCatalog={false} mayViewPanels={false} />,
    );
    await screen.findByText('Gold');
    fireEvent.click(screen.getByRole('button', { name: 'مجوزها' }));
    // The stored product is kept, typed, rather than dropped for want of a list.
    const typed = (await within(group('محصول')).findByLabelText('شناسه‌ها')) as HTMLTextAreaElement;
    expect(typed.value).toBe(PRODUCT_ID);
    expect(gets(api, '/products')).toHaveLength(0);
    expect(gets(api, '/product-categories')).toHaveLength(0);
    expect(gets(api, '/panels')).toHaveLength(0);
  });

  it('shows a reader the grants without an editor, and names the key', async () => {
    const api = stubApi([
      {
        url: '/reseller-tiers',
        body: { tiers: [tier({ grants: [{ kind: 'OPERATION', subject: null }] })] },
      },
    ]);
    renderPage(
      <ResellerTiersPage
        denied={false}
        mayEdit={false}
        mayViewCatalog={false}
        mayViewPanels={false}
      />,
    );
    await screen.findByText('Gold');
    fireEvent.click(screen.getByRole('button', { name: 'مجوزها' }));
    expect(await screen.findByText('مجوزهای سطح — Gold')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ذخیرهٔ مجوزها' })).toBeNull();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.getAllByText(/resellers\.edit/u).length).toBeGreaterThan(0);
    expect(api.calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('creates a tier with its limit in minor units and no percentage for the list price', async () => {
    const api = stubApi([{ url: '/reseller-tiers', body: { tiers: [] } }]);
    renderPage(<ResellerTiersPage denied={false} mayEdit mayViewCatalog mayViewPanels />);
    await screen.findByText('هنوز سطحی ساخته نشده است.');
    fireEvent.change(screen.getByLabelText('نام سطح'), { target: { value: ' Bronze ' } });
    fireEvent.change(screen.getByLabelText('سقف اعتبار (واحد خرد)'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'ساخت سطح' }));
    await waitFor(() => expect(posts(api, '/reseller-tiers')).toHaveLength(1));
    expect(posts(api, '/reseller-tiers')[0]?.body).toMatchObject({
      name: 'Bronze',
      pricingMode: 'LIST_PRICE',
      discountPercentage: null,
      creditLimit: { amount: '0', currency: 'IRT' },
    });
  });
});

// ---------------------------------------------------------------------------
// The customer page
// ---------------------------------------------------------------------------

const OFF = {
  mayBlock: false,
  mayEditTrial: false,
  mayViewWallet: false,
  mayCredit: false,
  mayDebit: false,
  mayViewOrders: false,
  mayViewServices: false,
  mayViewReferrals: false,
} as const;

const customerRoute = { url: `/users/${CUSTOMER_ID}`, body: { customer: customer() } };

describe("the customer's reseller card", () => {
  it('says a customer with no reseller row is not a reseller, and offers to register them', async () => {
    const api = stubApi([
      customerRoute,
      {
        url: `/resellers/${CUSTOMER_ID}`,
        status: 404,
        body: notFound('commerce.reseller_not_found'),
      },
    ]);
    renderPage(
      <UserDetailPage id={CUSTOMER_ID} {...OFF} mayViewReseller mayEditReseller denied={false} />,
    );
    const card = (await screen.findByRole('heading', { name: 'نمایندگی' })).closest(
      'section',
    ) as HTMLElement;
    expect(await within(card).findByText('این مشتری نماینده نیست.')).toBeInTheDocument();
    expect(
      within(card).getByText('ثبت این مشتری به‌عنوان نماینده').closest('a')?.getAttribute('href'),
    ).toBe(`/resellers?register=${CUSTOMER_ID}`);
    // A fact, not an error card.
    expect(within(card).queryByText('سرور این درخواست را نپذیرفت')).toBeNull();
    expect(gets(api, `/resellers/${CUSTOMER_ID}`)).toHaveLength(1);
  });

  it('offers no register link without resellers.edit', async () => {
    stubApi([
      customerRoute,
      {
        url: `/resellers/${CUSTOMER_ID}`,
        status: 404,
        body: notFound('commerce.reseller_not_found'),
      },
    ]);
    renderPage(
      <UserDetailPage
        id={CUSTOMER_ID}
        {...OFF}
        mayViewReseller
        mayEditReseller={false}
        denied={false}
      />,
    );
    await screen.findByText('این مشتری نماینده نیست.');
    expect(screen.queryByText('ثبت این مشتری به‌عنوان نماینده')).toBeNull();
  });

  it('treats any other 404 as the error it is, not as "not a reseller"', async () => {
    stubApi([
      customerRoute,
      {
        url: `/resellers/${CUSTOMER_ID}`,
        status: 404,
        body: notFound('commerce.customer_not_found'),
      },
    ]);
    renderPage(
      <UserDetailPage id={CUSTOMER_ID} {...OFF} mayViewReseller mayEditReseller denied={false} />,
    );
    const card = (await screen.findByRole('heading', { name: 'نمایندگی' })).closest(
      'section',
    ) as HTMLElement;
    expect(await within(card).findByText('سرور این درخواست را نپذیرفت')).toBeInTheDocument();
    expect(within(card).queryByText('این مشتری نماینده نیست.')).toBeNull();
  });

  it('shows the tier, status, pricing and the effective limit of a reseller', async () => {
    stubApi([
      customerRoute,
      {
        url: `/resellers/${CUSTOMER_ID}`,
        body: {
          reseller: reseller({
            status: 'SUSPENDED',
            pricingMode: 'PERCENTAGE_DISCOUNT',
            discountPercentage: 20,
            creditLimit: { amount: '900000', currency: 'IRT' },
            effectiveCreditLimit: { amount: '900000', currency: 'IRT' },
          }),
        },
      },
    ]);
    renderPage(
      <UserDetailPage id={CUSTOMER_ID} {...OFF} mayViewReseller mayEditReseller denied={false} />,
    );
    const card = (await screen.findByRole('heading', { name: 'نمایندگی' })).closest(
      'section',
    ) as HTMLElement;
    await within(card).findByText('Gold');
    expect(card.textContent).toContain('معلق');
    expect(card.textContent).toContain('درصد اختصاصی کمتر از قیمت فهرست');
    expect(card.textContent).toContain('20');
    expect(card.textContent).toContain('900,000');
    expect(card.textContent).toContain('اختصاصی این نماینده');
    expect(card.textContent).toContain('با قیمت فهرست و بدون اعتبار خرید می‌کند');
  });

  it('names the key and asks nothing without resellers.view', async () => {
    const api = stubApi([customerRoute]);
    renderPage(
      <UserDetailPage
        id={CUSTOMER_ID}
        {...OFF}
        mayViewReseller={false}
        mayEditReseller={false}
        denied={false}
      />,
    );
    expect(await screen.findByText(/resellers\.view/u)).toBeInTheDocument();
    expect(gets(api, '/resellers')).toHaveLength(0);
  });

  it('draws a negative wallet balance with its sign, and says why it can be negative', async () => {
    stubApi([
      customerRoute,
      { url: `/users/${CUSTOMER_ID}/wallet/entries`, body: { entries: [], nextCursor: null } },
      {
        url: `/users/${CUSTOMER_ID}/wallet`,
        body: {
          wallet: {
            customerId: CUSTOMER_ID,
            balanceAmount: '-150000',
            currency: 'IRT',
            entryCount: 3,
          },
        },
      },
    ]);
    renderPage(
      <UserDetailPage
        id={CUSTOMER_ID}
        {...OFF}
        mayViewWallet
        mayViewReseller={false}
        mayEditReseller={false}
        denied={false}
      />,
    );
    const card = (await screen.findByRole('heading', { name: 'کیف پول' })).closest(
      'section',
    ) as HTMLElement;
    await within(card).findByText('بدهکار');
    expect(card.textContent).toContain('−150,000');
    expect(card.textContent).toContain('سقف اعتبار');
  });

  it('draws no debt badge for a balance of zero or more', async () => {
    stubApi([
      customerRoute,
      { url: `/users/${CUSTOMER_ID}/wallet/entries`, body: { entries: [], nextCursor: null } },
      {
        url: `/users/${CUSTOMER_ID}/wallet`,
        body: {
          wallet: { customerId: CUSTOMER_ID, balanceAmount: '0', currency: 'IRT', entryCount: 0 },
        },
      },
    ]);
    renderPage(
      <UserDetailPage
        id={CUSTOMER_ID}
        {...OFF}
        mayViewWallet
        mayViewReseller={false}
        mayEditReseller={false}
        denied={false}
      />,
    );
    const card = (await screen.findByRole('heading', { name: 'کیف پول' })).closest(
      'section',
    ) as HTMLElement;
    await within(card).findByText('تعداد تراکنش');
    expect(within(card).queryByText('بدهکار')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The order's pricing card
// ---------------------------------------------------------------------------

describe("an order's reseller terms", () => {
  const pricing = (resellerTerms: Record<string, unknown> | null) => ({
    orderId: ORDER_ID,
    discountCode: null,
    subtotalAmount: '225000',
    discountAmount: '0',
    totalAmount: '225000',
    currency: 'IRT',
    adjustments: [],
    redemptions: [],
    cashback: null,
    reseller: resellerTerms,
  });

  const terms = (overrides: Record<string, unknown> = {}) => ({
    resellerCustomerId: CUSTOMER_ID,
    tierId: TIER_ID,
    tierName: 'Gold (then)',
    layer: 'TIER',
    percent: 10,
    listAmount: '250000',
    costAmount: '225000',
    promotionAmount: '5000',
    saleAmount: '220000',
    marginAmount: '25000',
    botInstanceId: BOT_ID,
    createdAt: '2026-09-10T12:31:00.000Z',
    ...overrides,
  });

  const detail = (body: Record<string, unknown>) => {
    stubApi([
      { url: `/orders/${ORDER_ID}`, body: { order: order({ state: 'PAID' }) } },
      { url: `/orders/${ORDER_ID}/pricing`, body },
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

  it('renders the tier, the layer as its trace step, the percent and every figure', async () => {
    const { container } = detail(pricing(terms()));
    expect(await screen.findByText('خرید نماینده')).toBeInTheDocument();
    const text = container.textContent ?? '';
    expect(text).toContain('Gold (then)');
    expect(text).toContain('نرخ سطح');
    expect(text).toContain('TIER_PRICE');
    for (const figure of ['250,000', '225,000', '5,000', '220,000', '25,000']) {
      expect(text, figure).toContain(figure);
    }
    expect(text).toContain('حاشیهٔ نماینده');
    expect(text).toContain('تومان');
    expect(text).toContain(BOT_ID);
    expect(
      within(container).getByText(CUSTOMER_ID.slice(0, 8)).closest('a')?.getAttribute('href'),
    ).toBe(`/users/${CUSTOMER_ID}`);
  });

  it('labels an override as USER_OVERRIDE, and the list layer with no step and no percent', async () => {
    const view = detail(pricing(terms({ layer: 'OVERRIDE', percent: 15 })));
    await screen.findByText('نرخ اختصاصی نماینده');
    expect(view.container.textContent).toContain('USER_OVERRIDE');
    view.unmount();

    const list = detail(
      pricing(terms({ layer: 'LIST', percent: null, costAmount: '250000', marginAmount: '0' })),
    );
    await screen.findByText('قیمت فهرست — سطح تغییری در قیمت نداد');
    expect(list.container.textContent).not.toContain('TIER_PRICE');
    expect(list.container.textContent).not.toContain('USER_OVERRIDE');
  });

  it('draws no reseller block for an ordinary customer', async () => {
    detail(pricing(null));
    await screen.findByText('قیمت این سفارش کش‌بکی در بر ندارد.');
    expect(screen.queryByText('خرید نماینده')).toBeNull();
  });
});

describe('the percentage field', () => {
  it('accepts 1 to 99 and refuses 100, as the contract does', () => {
    // A 100% reseller price is a zero-total order nothing can pay for (PR #69 review);
    // the form says so here rather than leaving it to a 400 from the server.
    expect(percentOf('1')).toBe(1);
    expect(percentOf('99')).toBe(99);
    expect(percentOf('100')).toBeNull();
    expect(percentOf('0')).toBeNull();
  });
});
