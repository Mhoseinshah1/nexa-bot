import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ResellerTierProductPriceRow, ResellerTierSummaryResponse } from '@nexa/contracts';
import {
  TierPricesEditor,
  groupByCategory,
  marginOf,
  pastedColumn,
  priceChangesOf,
  tierPriceAmountOf,
} from '../../apps/web/src/pages/reseller-tier-prices';
import { tierBodyFrom } from '../../apps/web/src/pages/reseller-tiers';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * Round 4 PR-G on the Web Admin: a tier's «قیمت محصولات».
 *
 * Every response goes through the real client and the real zod schema. What these cases
 * hold: no request without `catalog.view`; products grouped by category; a category's bulk
 * fill and a spreadsheet paste fill figures without saving; a save sends ONLY the changed
 * rows, in each product's list currency, an empty figure as a clear; the margin is drawn
 * from the server's two figures and an em dash where one is missing.
 */

const TIER_ID = '019290ab-cdef-7012-8345-6789abcdef01';
const CAT_1 = '019290ab-cdef-7012-8345-6789abcd0c01';
const P1 = '019290ab-cdef-7012-8345-6789abcd0001';
const P2 = '019290ab-cdef-7012-8345-6789abcd0002';
const P3 = '019290ab-cdef-7012-8345-6789abcd0003';

const tier: ResellerTierSummaryResponse = {
  id: TIER_ID,
  name: 'نمایندگی نقره‌ای',
  pricingMode: 'FIXED_PRICE_TABLE',
  discountPercentage: null,
  creditLimit: { amount: '0', currency: 'IRT' },
  grants: [],
  resellerCount: 1,
  monthlyMinimum: null,
  unpricedListFallback: false,
  createdAt: '2026-10-01T08:00:00.000Z',
  updatedAt: '2026-10-01T08:00:00.000Z',
};

function row(
  productId: string,
  title: string,
  list: string | null,
  tierPrice: string | null,
  categoryId: string | null = CAT_1,
): ResellerTierProductPriceRow {
  return {
    productId,
    title,
    status: 'ACTIVE',
    categoryId,
    categoryName: categoryId === null ? null : 'ماهانه',
    listPrice: list === null ? null : { amount: list, currency: 'IRT' },
    tierPrice: tierPrice === null ? null : { amount: tierPrice, currency: 'IRT' },
    tierPriceUpdatedAt: tierPrice === null ? null : '2026-10-02T08:00:00.000Z',
  };
}

const PAGE = {
  tierId: TIER_ID,
  items: [
    row(P1, 'یک ماهه ۵۰ گیگ', '1000000', '800000'),
    row(P2, 'یک ماهه ۱۰۰ گیگ', '1500000', null),
    row(P3, 'بی‌دسته', '500000', null, null),
  ],
  nextCursor: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tier price helpers', () => {
  it('reads a typed price: Persian digits and grouping accepted, zero and fractions refused', () => {
    expect(tierPriceAmountOf('۸۰۰٬۰۰۰')).toBe('800000');
    expect(tierPriceAmountOf('1,200,000')).toBe('1200000');
    expect(tierPriceAmountOf('')).toBeNull();
    expect(tierPriceAmountOf('  ')).toBeNull();
    expect(tierPriceAmountOf('0')).toBe('INVALID');
    expect(tierPriceAmountOf('12.5')).toBe('INVALID');
    expect(tierPriceAmountOf('-3')).toBe('INVALID');
  });

  it('reads a pasted spreadsheet column, the last cell of each line', () => {
    expect(pastedColumn('100\n200\n')).toEqual(['100', '200']);
    expect(pastedColumn('پلن الف\t100\r\nپلن ب\t200')).toEqual(['100', '200']);
    expect(pastedColumn('100\n\n300')).toEqual(['100', '', '300']);
  });

  it('draws the margin as list minus tier, and nothing when either is missing', () => {
    expect(marginOf({ amount: '1000000', currency: 'IRT' }, '800000')).toEqual({
      amountMinor: '200000',
      currency: 'IRT',
    });
    expect(marginOf({ amount: '1000000', currency: 'IRT' }, '1200000')?.amountMinor).toBe(
      '-200000',
    );
    expect(marginOf(null, '1')).toBeNull();
    expect(marginOf({ amount: '1', currency: 'IRT' }, null)).toBeNull();
  });

  it('groups the server order by category runs', () => {
    const groups = groupByCategory(PAGE.items);
    expect(groups.map((g) => [g.categoryId, g.rows.length])).toEqual([
      [CAT_1, 2],
      [null, 1],
    ]);
  });

  it('sends only changed rows, in the list currency, an empty figure as a clear', () => {
    const drafts = new Map([
      [P1, ''],
      [P2, '1200000'],
      [P3, ''],
    ]);
    expect(priceChangesOf(PAGE.items, drafts)).toEqual({
      prices: [
        { productId: P1, price: null },
        { productId: P2, price: { amount: '1200000', currency: 'IRT' } },
      ],
    });
    expect(priceChangesOf(PAGE.items, new Map([[P2, 'abc']]))).toEqual({
      problem: 'web.tier_prices_problem_amount',
    });
  });

  it('rewrites a stored row in a stale currency even for the same figure (Codex on #297)', () => {
    const stale = {
      ...row(P1, 'الف', '1000000', '800000'),
      tierPrice: { amount: '800000', currency: 'IRR' as const },
    };
    expect(priceChangesOf([stale], new Map([[P1, '800000']]))).toEqual({
      prices: [{ productId: P1, price: { amount: '800000', currency: 'IRT' } }],
    });
    // The same figure in the same currency is no change.
    expect(
      priceChangesOf([row(P1, 'الف', '1000000', '800000')], new Map([[P1, '800000']])),
    ).toEqual({
      prices: [],
    });
  });

  it('clears a stale tier price of a product with no list price, and refuses a new one', () => {
    const stale = row(P1, 'الف', null, '800000');
    expect(priceChangesOf([stale], new Map([[P1, '']]))).toEqual({
      prices: [{ productId: P1, price: null }],
    });
    expect(priceChangesOf([stale], new Map([[P1, '900000']]))).toEqual({
      problem: 'web.tier_prices_problem_unpriced',
    });
  });

  it('writes the unpriced-product option into the tier body', () => {
    const checked = tierBodyFrom({
      name: 'نقره‌ای',
      pricingMode: 'FIXED_PRICE_TABLE',
      percent: '',
      limitCurrency: 'IRT',
      unpricedListFallback: true,
    });
    expect('body' in checked && checked.body).toMatchObject({
      pricingMode: 'FIXED_PRICE_TABLE',
      discountPercentage: null,
      unpricedListFallback: true,
    });
  });
});

describe('«قیمت محصولات»', () => {
  it('asks nothing without catalog.view and names the permission', async () => {
    const api = stubApi([]);
    renderPage(<TierPricesEditor tier={tier} mayEdit mayViewCatalog={false} />);
    expect(await screen.findByText(t('web.tier_prices_catalog_denied'))).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });

  it('groups by category, fills a category and a pasted column, and saves only the changes', async () => {
    const api = stubApi([
      { url: `/reseller-tiers/${TIER_ID}/product-prices`, method: 'GET', body: PAGE },
      {
        url: `/reseller-tiers/${TIER_ID}/product-prices`,
        method: 'POST',
        body: { tierId: TIER_ID, set: 2, cleared: 0 },
      },
    ]);
    renderPage(<TierPricesEditor tier={tier} mayEdit mayViewCatalog />);
    expect(await screen.findByRole('heading', { name: 'ماهانه' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: t('web.tier_prices_no_category') }),
    ).toBeInTheDocument();

    // The bulk fill of the first category sets both of its rows, and saves nothing.
    const [fill] = screen.getAllByLabelText(t('web.tier_prices_fill_label'));
    fireEvent.change(fill as HTMLElement, { target: { value: '900000' } });
    const [apply] = screen.getAllByRole('button', { name: t('web.tier_prices_fill_apply') });
    fireEvent.click(apply as HTMLElement);
    expect(screen.getByLabelText('یک ماهه ۵۰ گیگ')).toHaveValue('900000');
    expect(screen.getByLabelText('یک ماهه ۱۰۰ گیگ')).toHaveValue('900000');
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(0);

    // A pasted two-line column fills this row and the next one.
    fireEvent.paste(screen.getByLabelText('یک ماهه ۱۰۰ گیگ'), {
      clipboardData: { getData: () => 'الف\t1100000\nب\t450000\n' },
    });
    expect(screen.getByLabelText('یک ماهه ۱۰۰ گیگ')).toHaveValue('1100000');
    expect(screen.getByLabelText('بی‌دسته')).toHaveValue('450000');

    fireEvent.click(screen.getByRole('button', { name: t('web.tier_prices_save') }));
    await waitFor(() => expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(1));
    const body = api.calls.find((c) => c.method === 'POST')?.body as {
      prices: unknown[];
      idempotencyKey: string;
    };
    expect(body.prices).toEqual([
      { productId: P1, price: { amount: '900000', currency: 'IRT' } },
      { productId: P2, price: { amount: '1100000', currency: 'IRT' } },
      { productId: P3, price: { amount: '450000', currency: 'IRT' } },
    ]);
    expect(body.idempotencyKey.length).toBeGreaterThanOrEqual(8);
  });

  it('keeps a stale price clearable when the list price is gone, and a new one closed', async () => {
    stubApi([
      {
        url: `/reseller-tiers/${TIER_ID}/product-prices`,
        method: 'GET',
        body: {
          ...PAGE,
          items: [row(P1, 'بی‌قیمت با سطح', null, '800000'), row(P2, 'بی‌قیمت', null, null)],
        },
      },
    ]);
    renderPage(<TierPricesEditor tier={tier} mayEdit mayViewCatalog />);
    expect(await screen.findByLabelText('بی‌قیمت با سطح')).toBeEnabled();
    expect(screen.getByLabelText('بی‌قیمت')).toBeDisabled();
  });

  it('locks every figure while a save is in flight, so no edit is lost to its success', async () => {
    stubApi([{ url: `/reseller-tiers/${TIER_ID}/product-prices`, method: 'GET', body: PAGE }]);
    const answered = vi.fn();
    const stubbed = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown, init?: RequestInit) =>
        (init?.method ?? 'GET') === 'POST'
          ? new Promise<Response>(() => answered())
          : stubbed(input as never, init),
      ),
    );
    renderPage(<TierPricesEditor tier={tier} mayEdit mayViewCatalog />);
    const input = await screen.findByLabelText('یک ماهه ۱۰۰ گیگ');
    fireEvent.change(input, { target: { value: '1200000' } });
    fireEvent.click(screen.getByRole('button', { name: t('web.tier_prices_save') }));
    await waitFor(() => expect(answered).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByLabelText('یک ماهه ۵۰ گیگ')).toBeDisabled());
    expect(screen.getByLabelText('یک ماهه ۱۰۰ گیگ')).toBeDisabled();
    for (const apply of screen.getAllByRole('button', { name: t('web.tier_prices_fill_apply') })) {
      expect(apply).toBeDisabled();
    }
  });

  it('draws the margin from the two figures, and an em dash for an unpriced row', async () => {
    stubApi([{ url: `/reseller-tiers/${TIER_ID}/product-prices`, method: 'GET', body: PAGE }]);
    const view = renderPage(<TierPricesEditor tier={tier} mayEdit={false} mayViewCatalog />);
    await screen.findByRole('heading', { name: 'ماهانه' });
    const first = screen.getByLabelText('یک ماهه ۵۰ گیگ').closest('tr') as HTMLElement;
    expect(within(first).getAllByTitle(/۲۰۰٬۰۰۰|200,000/u).length).toBeGreaterThan(0);
    const second = screen.getByLabelText('یک ماهه ۱۰۰ گیگ').closest('tr') as HTMLElement;
    expect(within(second).getAllByText('—').length).toBeGreaterThan(0);
    // Read-only without resellers.edit: the inputs are disabled and no save is drawn.
    expect(screen.getByLabelText('یک ماهه ۵۰ گیگ')).toBeDisabled();
    expect(
      within(view.container).queryByRole('button', { name: t('web.tier_prices_save') }),
    ).toBeNull();
  });
});
