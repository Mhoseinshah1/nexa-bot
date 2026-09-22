import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { ProductCategoriesPage } from '../../apps/web/src/pages/product-categories';
import { renderPage, stubApi } from './harness';

/**
 * The category screen, rendered against the shapes the server actually returns.
 *
 * Every fixture goes through the real API client and so is parsed by
 * `productCategoryListResponseSchema` — the same schema the server validates against —
 * which is what stops a fixture drifting from the contract and passing anyway.
 *
 * What this file is FOR is the pair of rules that are easy to implement as one:
 * status and visibility are independent, and their buttons must not be each other's.
 * `docs/wp5-categories-audit.md` §6.3 is the decision; the collapse it forbids is
 * invisible until a customer who was never meant to lose access does.
 */

const CATEGORY_ID = '01a05e35-c9ad-7e93-bef3-1ed9b55292ca';

function category(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CATEGORY_ID,
    name: 'عمومی',
    description: null,
    emoji: null,
    status: 'ACTIVE',
    visibility: 'VISIBLE',
    sortOrder: 0,
    productCount: 0,
    createdAt: '2026-02-01T08:00:00.000Z',
    updatedAt: '2026-09-10T12:30:00.000Z',
    ...overrides,
  };
}

const list = (categories: unknown[]) => [{ url: '/product-categories', body: { categories } }];

function rowFor(name: string): HTMLElement {
  const cell = screen.getByText(name);
  const row = cell.closest('tr');
  if (row === null) throw new Error('the name is not in a table row');
  return row;
}

describe('the category list', () => {
  it('renders the count the SERVER computed, withdrawn products included', async () => {
    /*
     * The count is a delete precondition, not a customer-facing number. An inactive
     * product blocks a delete exactly as an active one does, so the column shows what
     * `listForOperator` counted rather than anything this screen derives — deriving it
     * would be the second interpretation the audit forbids.
     */
    stubApi(list([category({ productCount: 11 })]));
    renderPage(<ProductCategoriesPage denied={false} mayEdit />);

    await screen.findByText('عمومی');
    expect(within(rowFor('عمومی')).getByText('11')).toBeTruthy();
  });

  it('shows the emoji when there is one, and renders fine without', async () => {
    // Absence is ordinary — §6.1 — so a category with no emoji is not a degraded one.
    stubApi(list([category({ emoji: '🔥', name: 'ویژه' }), category({ id: 'b', name: 'ساده' })]));
    renderPage(<ProductCategoriesPage denied={false} mayEdit />);

    await screen.findByText('ویژه');
    expect(within(rowFor('ویژه')).getByText('🔥', { exact: false })).toBeTruthy();
    expect(rowFor('ساده')).toBeTruthy();
  });

  it('offers an INACTIVE category activation and still its own visibility control', async () => {
    /*
     * The falsifiable half of §6.3.
     *
     * An implementation that collapsed the two flags into one switch would offer a
     * withdrawn category no way to be hidden or shown — the two buttons would have
     * become one. Asserting both are present on the same row is what catches that.
     */
    stubApi(list([category({ status: 'INACTIVE', visibility: 'VISIBLE' })]));
    renderPage(<ProductCategoriesPage denied={false} mayEdit />);

    await screen.findByText('عمومی');
    const row = within(rowFor('عمومی'));
    expect(row.getByRole('button', { name: 'فعال‌سازی' })).toBeTruthy();
    expect(row.getByRole('button', { name: 'پنهان کردن' })).toBeTruthy();
  });

  it('offers a HIDDEN category showing, and still its own status control', async () => {
    // The other direction of the same rule: hidden does not imply withdrawn.
    stubApi(list([category({ status: 'ACTIVE', visibility: 'HIDDEN' })]));
    renderPage(<ProductCategoriesPage denied={false} mayEdit />);

    await screen.findByText('عمومی');
    const row = within(rowFor('عمومی'));
    expect(row.getByRole('button', { name: 'نمایش در فهرست' })).toBeTruthy();
    expect(row.getByRole('button', { name: 'غیرفعال‌سازی' })).toBeTruthy();
  });

  it('sends hide to the VISIBILITY route and never to the status one', async () => {
    /*
     * The mutation, not just the label.
     *
     * A page that drew the right button and posted to `/deactivate` would pass every
     * assertion above while withdrawing a category from sale that its operator only
     * meant to unlist. The call is what is asserted.
     */
    const api = stubApi([
      ...list([category()]),
      {
        url: `/product-categories/${CATEGORY_ID}/hide`,
        body: { category: category({ visibility: 'HIDDEN' }) },
      },
    ]);
    renderPage(<ProductCategoriesPage denied={false} mayEdit />);

    await screen.findByText('عمومی');
    fireEvent.click(within(rowFor('عمومی')).getByRole('button', { name: 'پنهان کردن' }));

    await waitFor(() => {
      expect(api.calls.some((call) => call.url.endsWith('/hide'))).toBe(true);
    });
    expect(api.calls.some((call) => call.url.endsWith('/deactivate'))).toBe(false);
  });

  it('draws no write control at all for a view-only role', async () => {
    // The column header stays, because a table whose columns depend on the reader is a
    // table two operators describe differently.
    stubApi(list([category()]));
    renderPage(<ProductCategoriesPage denied={false} mayEdit={false} />);

    await screen.findByText('عمومی');
    expect(within(rowFor('عمومی')).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('button', { name: 'ذخیره' })).toBeNull();
  });

  it('offers the form even when the tenant has NO category', async () => {
    /*
     * The installation whose first product would otherwise be refused by a rule
     * nothing offered a way to satisfy. The form sits outside the empty state for
     * exactly this case.
     */
    stubApi(list([]));
    renderPage(<ProductCategoriesPage denied={false} mayEdit />);

    await screen.findByText('هنوز دسته‌ای ساخته نشده است');
    expect(screen.getByRole('button', { name: 'ذخیره' })).toBeTruthy();
  });
});

describe('deleting a category', () => {
  it('shows the server COUNT when the category still holds products', async () => {
    /*
     * "You cannot delete this" leaves an operator hunting. The refusal carries
     * `details.productCount`, and rendering it is the difference between a sentence
     * they can act on and one they cannot.
     */
    const api = stubApi([
      ...list([category({ productCount: 11 })]),
      {
        url: `/product-categories/${CATEGORY_ID}`,
        status: 409,
        body: {
          error: {
            kind: 'CONFLICT',
            code: 'commerce.category_not_empty',
            message: 'این دسته هنوز محصول دارد.',
            details: { productCount: 11 },
            correlationId: 'c',
          },
        },
      },
    ]);
    renderPage(<ProductCategoriesPage denied={false} mayEdit />);

    await screen.findByText('عمومی');
    window.confirm = () => true;
    fireEvent.click(within(rowFor('عمومی')).getByRole('button', { name: 'حذف' }));

    /*
     * The count is asserted INSIDE the banner, not anywhere on the page — the table
     * already shows an 11 in the count column, and a looser matcher would pass against
     * that while the refusal said nothing useful at all.
     */
    const banner = await screen.findByText(/این دسته هنوز محصول دارد/);
    expect(banner.textContent).toContain('11');
    expect(api.calls.some((call) => call.method === 'DELETE')).toBe(true);
  });

  it('sends nothing when the confirmation is declined', async () => {
    const api = stubApi(list([category()]));
    renderPage(<ProductCategoriesPage denied={false} mayEdit />);

    await screen.findByText('عمومی');
    window.confirm = () => false;
    fireEvent.click(within(rowFor('عمومی')).getByRole('button', { name: 'حذف' }));

    expect(api.calls.some((call) => call.method === 'DELETE')).toBe(false);
  });
});

describe('reordering', () => {
  it('sends the WHOLE new order, renumbered from zero', async () => {
    /*
     * The server refuses a short match rather than reordering what it recognises, so a
     * subset believed complete would be rejected — and positions are renumbered rather
     * than swapped because `sort_order` has no unique index, and swapping two equal
     * values is a move that changes nothing while reporting success.
     */
    const api = stubApi([
      ...list([
        category({ id: CATEGORY_ID, name: 'اول', sortOrder: 0 }),
        category({ id: '01a05e35-c9ad-7e93-bef3-1ed9b55292cb', name: 'دوم', sortOrder: 0 }),
      ]),
      { url: '/product-categories/reorder', body: { categories: [] } },
    ]);
    renderPage(<ProductCategoriesPage denied={false} mayEdit />);

    await screen.findByText('اول');
    fireEvent.click(within(rowFor('دوم')).getByRole('button', { name: 'بالاتر' }));

    await waitFor(() => {
      const call = api.calls.find((c) => c.url.endsWith('/reorder'));
      expect(call).toBeTruthy();
      expect((call?.body as { positions: unknown[] }).positions).toStrictEqual([
        { id: '01a05e35-c9ad-7e93-bef3-1ed9b55292cb', sortOrder: 0 },
        { id: CATEGORY_ID, sortOrder: 1 },
      ]);
    });
  });

  it('cannot move the first row up or the last row down', async () => {
    stubApi(
      list([
        category({ id: CATEGORY_ID, name: 'اول' }),
        category({ id: '01a05e35-c9ad-7e93-bef3-1ed9b55292cb', name: 'دوم' }),
      ]),
    );
    renderPage(<ProductCategoriesPage denied={false} mayEdit />);

    await screen.findByText('اول');
    expect(
      within(rowFor('اول')).getByRole('button', { name: 'بالاتر' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(
      within(rowFor('دوم')).getByRole('button', { name: 'پایین‌تر' }).hasAttribute('disabled'),
    ).toBe(true);
  });
});
