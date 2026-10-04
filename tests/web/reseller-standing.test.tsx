import { describe, expect, it } from 'vitest';
import type { PermissionKey } from '@nexa/contracts';
import type { ReactElement } from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { resolve } from '../../apps/web/src/app';
import { ResellersPage } from '../../apps/web/src/pages/resellers';
import { ResellerTiersPage } from '../../apps/web/src/pages/reseller-tiers';
import { changedFieldsOf } from '../../apps/web/src/pages/reseller-standing';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi, type Api } from './harness';

/**
 * WP14 on the Web Admin (`docs/wp14-reseller-phase2-audit.md` D4): a reseller's balance,
 * purchases and history.
 *
 * Reseller credit was removed (owner decision, 2026-10-01: no reseller debt, no credit
 * purchases). The balance card offers no limit, allowance or "available on credit"; a
 * negative balance is shown as the legacy debt it is. The form offers no limit and sends
 * none, so there is nothing left to acknowledge before a save.
 *
 * Every response goes through the real client and the contract schemas. The cases hold
 * what the screen DOES: ask for each view only with the key its route charges, and draw
 * the server's figures without computing any.
 */

const CUSTOMER_ID = '019210ab-cdef-7012-8345-6789abcdef01';
const TIER_ID = '019290ab-cdef-7012-8345-6789abcdef01';
const ORDER_ID = '019230ab-cdef-7012-8345-6789abcdef01';

const tier = (overrides: Record<string, unknown> = {}) => ({
  id: TIER_ID,
  name: 'Gold',
  pricingMode: 'PERCENTAGE_DISCOUNT',
  discountPercentage: 20,
  creditLimit: { amount: '0', currency: 'IRT' },
  grants: [],
  resellerCount: 1,
  monthlyMinimum: null,
  createdAt: '2026-09-01T08:00:00.000Z',
  updatedAt: '2026-09-01T08:00:00.000Z',
  ...overrides,
});

const reseller = (overrides: Record<string, unknown> = {}) => ({
  customerId: CUSTOMER_ID,
  telegramUserId: '5551234567',
  displayName: 'Reza Reseller',
  tier: { id: TIER_ID, name: 'Gold' },
  status: 'ACTIVE',
  pricingMode: 'TIER',
  discountPercentage: null,
  creditLimit: null,
  effectiveCreditLimit: { amount: '0', currency: 'IRT' },
  createdAt: '2026-09-02T08:00:00.000Z',
  updatedAt: '2026-09-02T08:00:00.000Z',
  ...overrides,
});

const IRT = (amount: string) => ({ amount, currency: 'IRT' as const });

/** A reseller with a LEGACY debt: run up under the credit line the owner removed. */
const credit = (overrides: Record<string, unknown> = {}) => ({
  customerId: CUSTOMER_ID,
  status: 'ACTIVE',
  effectiveLimit: IRT('0'),
  limitSource: 'TIER',
  sellingCurrency: 'IRT',
  credit: 'NO_LIMIT',
  balance: IRT('-80000'),
  allowance: IRT('0'),
  creditInUse: IRT('80000'),
  availableToSpend: IRT('-80000'),
  overLimitBy: IRT('80000'),
  ...overrides,
});

const LEGACY_DEBT = /بدهی‌ای که پیش از حذف خرید اعتباری ایجاد شده است/u;

const purchase = {
  orderId: ORDER_ID,
  orderState: 'PAID',
  purpose: 'NEW_SERVICE',
  confirmedAt: '2026-09-03T08:00:00.000Z',
  tierName: 'Gold',
  layer: 'TIER',
  percent: 20,
  listAmount: '100000',
  costAmount: '80000',
  promotionAmount: '0',
  saleAmount: '80000',
  currency: 'IRT',
};

const historyEntry = (overrides: Record<string, unknown> = {}) => ({
  id: '019240ab-cdef-7012-8345-6789abcdef01',
  action: 'reseller.update',
  actorType: 'WEB_ADMIN',
  actorLabel: 'owner',
  surface: 'WEB',
  result: 'SUCCESS',
  occurredAt: '2026-09-04T08:00:00.000Z',
  before: { status: 'ACTIVE', tierId: TIER_ID },
  after: { status: 'SUSPENDED', tierId: TIER_ID },
  ...overrides,
});

const routes = (standing = credit()) => [
  { url: '/resellers', body: { resellers: [reseller()], nextCursor: null } },
  { url: '/reseller-tiers', body: { tiers: [tier()] } },
  { url: `/resellers/${CUSTOMER_ID}/credit`, body: { credit: standing } },
  { url: `/resellers/${CUSTOMER_ID}/purchases`, body: { purchases: [purchase], nextCursor: null } },
  { url: `/resellers/${CUSTOMER_ID}/history`, body: { entries: [historyEntry()] } },
  { url: `/resellers/${CUSTOMER_ID}`, body: { reseller: reseller() } },
];

const gets = (api: Api, path: string) =>
  api.calls.filter((call) => call.method === 'GET' && call.url.includes(path));
const posts = (api: Api, path: string) =>
  api.calls.filter((call) => call.method === 'POST' && call.url.includes(path));

const render = (keys: { wallet?: boolean; orders?: boolean; audit?: boolean } = {}) =>
  renderPage(
    <ResellersPage
      route={{ path: '/resellers', query: new URLSearchParams() }}
      denied={false}
      mayEdit
      mayViewWallet={keys.wallet ?? true}
      mayViewOrders={keys.orders ?? true}
      mayViewAudit={keys.audit ?? true}
    />,
  );

describe('the reseller standing cards', () => {
  it('draws the server’s balance and legacy debt, the purchase as recorded and the history', async () => {
    stubApi(routes());
    render();
    await screen.findByText('Reza Reseller');
    fireEvent.click(screen.getByRole('button', { name: 'وضعیت' }));

    expect(await screen.findByText(LEGACY_DEBT)).toBeInTheDocument();
    const card = screen.getByText('کیف پول نماینده').closest('section') ?? document.body;
    const text = card.textContent ?? '';
    expect(text).toContain('−80,000');
    expect(text).toContain('بدهی پیشین (مانده منفی)');
    // No credit line is drawn: no limit, no allowance, nothing "available on credit".
    expect(text).not.toContain('سقف');
    expect(text).not.toContain('قابل خرید با اعتبار');
    // No settlement, collection or due date is named anywhere (`OQ-WP9-04`).
    expect(text).toContain('تسویه، وصول یا جریمه نمی‌کند');

    const purchases = await screen.findByRole('table', { name: 'خریدهای نماینده' });
    expect(within(purchases).getByText('پرداخت‌شده')).toBeInTheDocument();
    expect(purchases.textContent).toContain('80,000');
    expect(purchases.textContent).not.toContain('margin');

    const history = await screen.findByRole('table', { name: 'تاریخچهٔ تغییرات' });
    expect(history.textContent).toContain('ویرایش نماینده');
    expect(history.textContent).toContain('owner');
    // Only the field that changed is named; the tier did not change.
    expect(history.textContent).toContain('وضعیت');
    expect(history.textContent).not.toContain('سطح');
  });

  it('draws no debt line and no warning for a balance at or above zero', async () => {
    stubApi(
      routes(
        credit({
          balance: IRT('5000'),
          creditInUse: IRT('0'),
          availableToSpend: IRT('5000'),
          overLimitBy: IRT('0'),
        }),
      ),
    );
    render();
    await screen.findByText('Reza Reseller');
    fireEvent.click(screen.getByRole('button', { name: 'وضعیت' }));
    const card = (await screen.findByText('کیف پول نماینده')).closest('section') ?? document.body;
    await waitFor(() => expect(card.textContent).toContain('5,000'));
    expect(card.textContent).not.toContain('بدهی پیشین (مانده منفی)');
    expect(screen.queryByText(LEGACY_DEBT)).toBeNull();
  });

  it('asks for each view only with its key, and names the key otherwise', async () => {
    const api = stubApi(routes());
    render({ wallet: false, orders: false, audit: false });
    await screen.findByText('Reza Reseller');
    fireEvent.click(screen.getByRole('button', { name: 'وضعیت' }));
    // The exact wallet sentence: the register form's customer picker names users.view too.
    expect(await screen.findByText(t('web.reseller_credit_denied'))).toBeInTheDocument();
    expect(screen.getByText(/orders\.view/u)).toBeInTheDocument();
    expect(screen.getByText(/audit\.view/u)).toBeInTheDocument();
    expect(gets(api, '/credit')).toHaveLength(0);
    expect(gets(api, '/purchases')).toHaveLength(0);
    expect(gets(api, '/history')).toHaveLength(0);
  });

  it('asks for the tier history only on audit.view, and shows it when opened', async () => {
    const api = stubApi([
      { url: '/reseller-tiers', body: { tiers: [tier()] } },
      {
        url: `/reseller-tiers/${TIER_ID}/history`,
        body: {
          entries: [
            historyEntry({
              action: 'reseller_tier.grants',
              before: { grants: [] },
              after: { grants: [{ kind: 'BOT', subject: null }] },
            }),
          ],
        },
      },
    ]);
    const view = renderPage(
      <ResellerTiersPage
        denied={false}
        mayEdit={false}
        mayViewCatalog={false}
        mayViewPanels={false}
        mayViewAudit
      />,
    );
    await within(view.container).findByText('Gold');
    fireEvent.click(within(view.container).getByRole('button', { name: 'تاریخچه' }));
    const history = await within(view.container).findByRole('table', { name: 'تاریخچهٔ تغییرات' });
    expect(history.textContent).toContain('تغییر مجوزها');
    expect(gets(api, `/reseller-tiers/${TIER_ID}/history`)).toHaveLength(1);
  });
});

describe('the reseller form offers no credit', () => {
  const openEdit = async () => {
    await screen.findByText('Reza Reseller');
    fireEvent.click(screen.getByRole('button', { name: 'ویرایش' }));
  };

  it('has no limit field, and saves a suspension of a reseller with a legacy debt with null', async () => {
    const api = stubApi(routes());
    render();
    await openEdit();
    expect(screen.queryByLabelText('سقف اعتبار اختصاصی')).toBeNull();
    expect(screen.queryByLabelText('سقف اعتبار (واحد خرد)')).toBeNull();
    fireEvent.change(screen.getByLabelText('وضعیت'), { target: { value: 'SUSPENDED' } });
    const save = screen.getByRole('button', { name: 'ذخیره' });
    await waitFor(() => expect(save).not.toBeDisabled());
    fireEvent.click(save);
    await waitFor(() => expect(posts(api, `/resellers/${CUSTOMER_ID}`)).toHaveLength(1));
    expect(posts(api, `/resellers/${CUSTOMER_ID}`)[0]?.body).toMatchObject({
      status: 'SUSPENDED',
      creditLimit: null,
    });
  });
});

describe('changedFieldsOf', () => {
  it('names the top-level fields whose stored value changed, and none for a creation', () => {
    expect(changedFieldsOf(historyEntry() as never)).toEqual(['status']);
    expect(
      changedFieldsOf(historyEntry({ before: null, after: { status: 'ACTIVE' } }) as never),
    ).toEqual(['status']);
    expect(changedFieldsOf(historyEntry({ after: null }) as never)).toEqual([]);
  });
});

/**
 * The routes' wiring, not the pages'.
 *
 * Every case above hands `ResellersPage` and `ResellerTiersPage` their booleans directly,
 * so none of them could see `resolve` pass the wrong key — or a constant — into
 * `mayViewWallet`, `mayViewOrders` or `mayViewAudit`. These go through the real `resolve`
 * with the permission sets a role actually holds, one key at a time, so a key wired to
 * the wrong card fails as surely as one wired to nothing.
 */
describe('the /resellers and /reseller-tiers routes wire each WP14 read to its own key', () => {
  const open = (path: string, permissions: readonly PermissionKey[]) =>
    renderPage(
      resolve({ path, query: new URLSearchParams() }, permissions).element as ReactElement,
    );

  const VIEWS = [
    { key: 'users.view', fragment: '/credit', denial: /users\.view/u },
    { key: 'orders.view', fragment: '/purchases', denial: /orders\.view/u },
    { key: 'audit.view', fragment: '/history', denial: /audit\.view/u },
  ] as const;

  it('asks for none of the three views on resellers.view alone, and names each key', async () => {
    const api = stubApi(routes());
    open('/resellers', ['resellers.view']);
    await screen.findByText('Reza Reseller');
    fireEvent.click(screen.getByRole('button', { name: 'وضعیت' }));

    for (const view of VIEWS) {
      expect(await screen.findByText(view.denial), view.key).toBeInTheDocument();
      expect(gets(api, view.fragment), view.key).toHaveLength(0);
    }
  });

  for (const held of VIEWS) {
    it(`asks for the ${held.fragment} view on ${held.key}, and only that one`, async () => {
      const api = stubApi(routes());
      open('/resellers', ['resellers.view', held.key]);
      await screen.findByText('Reza Reseller');
      fireEvent.click(screen.getByRole('button', { name: 'وضعیت' }));

      await waitFor(() => expect(gets(api, held.fragment)).toHaveLength(1));
      expect(screen.queryByText(held.denial)).toBeNull();
      for (const other of VIEWS.filter((view) => view !== held)) {
        expect(screen.getByText(other.denial), other.key).toBeInTheDocument();
        expect(gets(api, other.fragment), other.key).toHaveLength(0);
      }
    });
  }

  it('draws what each held key reads, from the server', async () => {
    stubApi(routes());
    open('/resellers', ['resellers.view', 'users.view', 'orders.view', 'audit.view']);
    await screen.findByText('Reza Reseller');
    fireEvent.click(screen.getByRole('button', { name: 'وضعیت' }));

    expect(await screen.findByText(LEGACY_DEBT)).toBeInTheDocument();
    expect(await screen.findByRole('table', { name: 'خریدهای نماینده' })).toBeInTheDocument();
    expect(await screen.findByRole('table', { name: 'تاریخچهٔ تغییرات' })).toBeInTheDocument();
  });

  /** The edit form reads no balance at all: with no credit, there is nothing to acknowledge. */
  it('lets an editor without users.view save a suspension without asking for the credit', async () => {
    const api = stubApi(routes());
    open('/resellers', ['resellers.view', 'resellers.edit']);
    await screen.findByText('Reza Reseller');
    fireEvent.click(screen.getByRole('button', { name: 'ویرایش' }));
    fireEvent.change(screen.getByLabelText('وضعیت'), { target: { value: 'SUSPENDED' } });

    await waitFor(() => expect(screen.getByRole('button', { name: 'ذخیره' })).not.toBeDisabled());
    expect(screen.queryByLabelText('متوجه شدم؛ ذخیره شود.')).toBeNull();
    expect(gets(api, '/credit')).toHaveLength(0);
  });

  it('lets an editor holding users.view suspend a reseller with a legacy debt, asking nothing', async () => {
    const api = stubApi(routes());
    open('/resellers', ['resellers.view', 'resellers.edit', 'users.view']);
    await screen.findByText('Reza Reseller');
    fireEvent.click(screen.getByRole('button', { name: 'ویرایش' }));
    fireEvent.change(screen.getByLabelText('وضعیت'), { target: { value: 'SUSPENDED' } });

    await waitFor(() => expect(screen.getByRole('button', { name: 'ذخیره' })).not.toBeDisabled());
    expect(screen.queryByLabelText('متوجه شدم؛ ذخیره شود.')).toBeNull();
    // The one balance read is the standing card's, never the form's.
    expect(gets(api, '/credit').length).toBeLessThanOrEqual(1);
  });

  const tierRoutes = [
    { url: '/reseller-tiers', body: { tiers: [tier()] } },
    { url: `/reseller-tiers/${TIER_ID}/history`, body: { entries: [historyEntry()] } },
  ];

  it('asks for no tier history on resellers.view alone, and names audit.view', async () => {
    const api = stubApi(tierRoutes);
    const view = open('/reseller-tiers', ['resellers.view']);
    await within(view.container).findByText('Gold');
    fireEvent.click(within(view.container).getByRole('button', { name: 'تاریخچه' }));

    expect(await within(view.container).findByText(/audit\.view/u)).toBeInTheDocument();
    expect(gets(api, '/history')).toHaveLength(0);
  });

  it('asks for the tier history on audit.view and draws it', async () => {
    const api = stubApi(tierRoutes);
    const view = open('/reseller-tiers', ['resellers.view', 'audit.view']);
    await within(view.container).findByText('Gold');
    fireEvent.click(within(view.container).getByRole('button', { name: 'تاریخچه' }));

    expect(
      await within(view.container).findByRole('table', { name: 'تاریخچهٔ تغییرات' }),
    ).toBeInTheDocument();
    expect(gets(api, `/reseller-tiers/${TIER_ID}/history`)).toHaveLength(1);
    expect(within(view.container).queryByText(/audit\.view/u)).toBeNull();
  });
});
