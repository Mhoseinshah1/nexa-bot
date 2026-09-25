import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  ResellersPage,
  debtWarningOf,
  type ResellerFormState,
} from '../../apps/web/src/pages/resellers';
import { ResellerTiersPage } from '../../apps/web/src/pages/reseller-tiers';
import { changedFieldsOf } from '../../apps/web/src/pages/reseller-standing';
import { renderPage, stubApi, type Api } from './harness';

/**
 * WP14 on the Web Admin (`docs/wp14-reseller-phase2-audit.md` D4): a reseller's credit
 * standing, purchases and history, and the two acknowledgements before a save that
 * leaves a debt uncovered.
 *
 * Every response goes through the real client and the contract schemas. The cases hold
 * what the screen DOES: ask for each view only with the key its route charges, draw the
 * server's figures without computing any, and refuse to save a limit below the debt or a
 * suspension of a reseller who owes until the operator has read what that means — while
 * sending exactly the body it always sent.
 */

const CUSTOMER_ID = '019210ab-cdef-7012-8345-6789abcdef01';
const TIER_ID = '019290ab-cdef-7012-8345-6789abcdef01';
const ORDER_ID = '019230ab-cdef-7012-8345-6789abcdef01';

const tier = (overrides: Record<string, unknown> = {}) => ({
  id: TIER_ID,
  name: 'Gold',
  pricingMode: 'PERCENTAGE_DISCOUNT',
  discountPercentage: 20,
  creditLimit: { amount: '100000', currency: 'IRT' },
  grants: [],
  resellerCount: 1,
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
  effectiveCreditLimit: { amount: '100000', currency: 'IRT' },
  createdAt: '2026-09-02T08:00:00.000Z',
  updatedAt: '2026-09-02T08:00:00.000Z',
  ...overrides,
});

const IRT = (amount: string) => ({ amount, currency: 'IRT' as const });

const credit = (overrides: Record<string, unknown> = {}) => ({
  customerId: CUSTOMER_ID,
  status: 'ACTIVE',
  effectiveLimit: IRT('100000'),
  limitSource: 'TIER',
  sellingCurrency: 'IRT',
  credit: 'CREDIT_APPLIES',
  balance: IRT('-80000'),
  allowance: IRT('100000'),
  creditInUse: IRT('80000'),
  availableToSpend: IRT('20000'),
  overLimitBy: IRT('0'),
  ...overrides,
});

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
  it('draws the server’s credit figures, the purchase as recorded and the history', async () => {
    stubApi(routes(credit({ overLimitBy: IRT('0') })));
    render();
    await screen.findByText('Reza Reseller');
    fireEvent.click(screen.getByRole('button', { name: 'وضعیت' }));

    expect(await screen.findByText('اعمال می‌شود')).toBeInTheDocument();
    const card = screen.getByText('اعتبار نماینده').closest('section') ?? document.body;
    const text = card.textContent ?? '';
    expect(text).toContain('−80,000');
    expect(text).toContain('20,000');
    expect(text).toContain('100,000');
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

  it('warns when the debt is beyond the current limit', async () => {
    stubApi(
      routes(
        credit({
          allowance: IRT('50000'),
          effectiveLimit: IRT('50000'),
          limitSource: 'RESELLER',
          availableToSpend: IRT('-30000'),
          overLimitBy: IRT('30000'),
        }),
      ),
    );
    render();
    await screen.findByText('Reza Reseller');
    fireEvent.click(screen.getByRole('button', { name: 'وضعیت' }));
    expect(await screen.findByText(/بدهی این نماینده از سقف کنونی بیشتر است/u)).toBeInTheDocument();
  });

  it('asks for each view only with its key, and names the key otherwise', async () => {
    const api = stubApi(routes());
    render({ wallet: false, orders: false, audit: false });
    await screen.findByText('Reza Reseller');
    fireEvent.click(screen.getByRole('button', { name: 'وضعیت' }));
    expect(await screen.findByText(/users\.view/u)).toBeInTheDocument();
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

describe('acknowledging a debt before a save', () => {
  const openEdit = async () => {
    await screen.findByText('Reza Reseller');
    fireEvent.click(screen.getByRole('button', { name: 'ویرایش' }));
  };

  it('requires an acknowledgement to lower the limit below the debt, and sends the same body', async () => {
    const api = stubApi(routes());
    render();
    await openEdit();
    fireEvent.click(screen.getByLabelText('سقف اعتبار اختصاصی'));
    fireEvent.change(screen.getByLabelText('سقف اعتبار (واحد خرد)'), {
      target: { value: '50000' },
    });
    expect(
      await screen.findByText(/سقف تازه از بدهی کنونی این نماینده کمتر است/u),
    ).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'ذخیره' });
    expect(save).toBeDisabled();

    fireEvent.click(screen.getByLabelText('متوجه شدم؛ ذخیره شود.'));
    expect(save).not.toBeDisabled();
    fireEvent.click(save);
    await waitFor(() => expect(posts(api, `/resellers/${CUSTOMER_ID}`)).toHaveLength(1));
    expect(posts(api, `/resellers/${CUSTOMER_ID}`)[0]?.body).toMatchObject({
      status: 'ACTIVE',
      creditLimit: { amount: '50000', currency: 'IRT' },
    });
  });

  it('requires an acknowledgement to suspend a reseller who owes', async () => {
    stubApi(routes());
    render();
    await openEdit();
    fireEvent.change(screen.getByLabelText('وضعیت'), { target: { value: 'SUSPENDED' } });
    expect(await screen.findByText(/تعلیق بدهی را سر جای خود نگه می‌دارد/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ذخیره' })).toBeDisabled();
  });

  it('asks for nothing when nothing is owed', async () => {
    stubApi(
      routes(
        credit({ balance: IRT('5000'), creditInUse: IRT('0'), availableToSpend: IRT('105000') }),
      ),
    );
    render();
    await openEdit();
    fireEvent.change(screen.getByLabelText('وضعیت'), { target: { value: 'SUSPENDED' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'ذخیره' })).not.toBeDisabled());
    expect(screen.queryByLabelText('متوجه شدم؛ ذخیره شود.')).toBeNull();
  });

  it('acknowledgement is reset by any further change', async () => {
    stubApi(routes());
    render();
    await openEdit();
    fireEvent.change(screen.getByLabelText('وضعیت'), { target: { value: 'SUSPENDED' } });
    fireEvent.click(await screen.findByLabelText('متوجه شدم؛ ذخیره شود.'));
    expect(screen.getByRole('button', { name: 'ذخیره' })).not.toBeDisabled();
    fireEvent.change(screen.getByLabelText('قیمت‌گذاری'), { target: { value: 'LIST_PRICE' } });
    expect(screen.getByRole('button', { name: 'ذخیره' })).toBeDisabled();
  });
});

describe('debtWarningOf', () => {
  const state = (overrides: Partial<ResellerFormState> = {}): ResellerFormState => ({
    customerId: CUSTOMER_ID,
    tierId: TIER_ID,
    status: 'ACTIVE',
    pricingMode: 'TIER',
    percent: '',
    ownLimit: false,
    limitAmount: '',
    limitCurrency: 'IRT',
    ...overrides,
  });
  const before = reseller() as never;
  const tiers = [tier()] as never;

  it('is silent without the credit standing, and when nothing is owed', () => {
    expect(debtWarningOf(before, state({ status: 'SUSPENDED' }), tiers, undefined)).toBeNull();
    expect(
      debtWarningOf(
        before,
        state({ status: 'SUSPENDED' }),
        tiers,
        credit({ creditInUse: IRT('0') }) as never,
      ),
    ).toBeNull();
  });

  it('warns on a limit that settlement would read as below the debt, including another currency', () => {
    const owes = credit() as never;
    expect(
      debtWarningOf(before, state({ ownLimit: true, limitAmount: '79999' }), tiers, owes),
    ).toBe('web.reseller_confirm_limit_below_debt');
    expect(
      debtWarningOf(before, state({ ownLimit: true, limitAmount: '80000' }), tiers, owes),
    ).toBeNull();
    expect(
      debtWarningOf(
        before,
        state({ ownLimit: true, limitAmount: '500000', limitCurrency: 'USD' }),
        tiers,
        owes,
      ),
    ).toBe('web.reseller_confirm_limit_below_debt');
    // Unchanged terms under an existing over-limit debt: nothing is being lowered.
    expect(
      debtWarningOf(
        before,
        state(),
        [tier({ creditLimit: IRT('50000') })] as never,
        credit({ allowance: IRT('50000') }) as never,
      ),
    ).toBeNull();
  });

  it('warns on suspending an ACTIVE reseller who owes, and not on keeping one suspended', () => {
    const owes = credit() as never;
    expect(debtWarningOf(before, state({ status: 'SUSPENDED' }), tiers, owes)).toBe(
      'web.reseller_confirm_suspend_debt',
    );
    expect(
      debtWarningOf(
        reseller({ status: 'SUSPENDED' }) as never,
        state({ status: 'SUSPENDED' }),
        tiers,
        owes,
      ),
    ).toBeNull();
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
