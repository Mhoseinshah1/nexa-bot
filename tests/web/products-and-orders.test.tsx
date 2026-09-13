import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { catalogueGap, ProductDetailPage, ProductsPage } from '../../apps/web/src/pages/products';
import { OrderDetailPage, OrdersPage } from '../../apps/web/src/pages/orders';
import { resolve } from '../../apps/web/src/app';
import { order, panel, product, renderPage, stubApi } from './harness';

/**
 * Products and Orders, rendered against the shapes the server actually returns.
 *
 * Everything goes through the real API client, so every fixture is parsed by
 * `productSummarySchema` / `orderSummarySchema` — the same schemas the server validates
 * against. A fixture that drifted from the contract fails here rather than in production.
 *
 * Four assertions in this file MOVED here from `planned-and-absent.test.tsx` when Phase
 * 4B turned these two routes from planned pages into real ones: owner revisions 3, 6, 10
 * and 11. They were recorded as copy on pages no route renders any more, and an absence
 * asserted against an unreachable screen is a green test for nothing. Revision 6 is no
 * longer only copy — the snapshot is real behaviour — so it is asserted twice here.
 */

const PRODUCTS_ROUTE = { path: '/products', query: new URLSearchParams() };
const ORDERS_ROUTE = { path: '/orders', query: new URLSearchParams() };

const productList = (products: unknown[], nextCursor: string | null = null) => [
  { url: '/products', body: { products, nextCursor } },
  // The form's panel picker. Registered on every products fixture so a case that is
  // not about the picker does not fail on an unrouted request.
  { url: '/panels', body: { panels: [panel()], nextCursor: null } },
];

const orderList = (orders: unknown[], nextCursor: string | null = null) => [
  { url: '/orders', body: { orders, nextCursor } },
];

// ---------------------------------------------------------------------------
// The catalogue gap — the reason this page exists in this shape
// ---------------------------------------------------------------------------

describe('whether a customer can see a product', () => {
  /**
   * The same 24-cell matrix the server's two copies are checked against.
   *
   * `catalog.test.ts` asserts the SQL predicate and the TypeScript one agree; this
   * asserts the Web Admin's third statement of the same rule agrees with both. Without
   * it the badge could quietly say "in the catalogue" for a product the bot will never
   * list, which is precisely the question an operator opens this page to answer.
   */
  it('agrees with the server for every combination of the four predicates', () => {
    for (const status of ['ACTIVE', 'INACTIVE'] as const) {
      for (const audience of ['EVERYONE', 'RESELLERS_ONLY', 'HIDDEN'] as const) {
        for (const priced of [true, false]) {
          for (const fulfillable of [true, false]) {
            const row = product({
              status,
              audience,
              priceAmount: priced ? '250000' : null,
              priceCurrency: priced ? 'IRT' : null,
              panelId: fulfillable ? '01a05e35-c9ad-7e93-bef3-1ed9b55292c8' : null,
            });
            const visible = status === 'ACTIVE' && audience !== 'HIDDEN' && priced && fulfillable;
            const label = `${status}/${audience}/priced=${String(priced)}/panel=${String(fulfillable)}`;
            expect(catalogueGap(row as never) === null, label).toBe(visible);
          }
        }
      }
    }
  });

  it('names the FIRST thing wrong, in the server’s own order', () => {
    // An operator fixing them one at a time is told the next thing, and the first is
    // the one they most likely did on purpose.
    expect(
      catalogueGap(
        product({ status: 'INACTIVE', priceAmount: null, priceCurrency: null }) as never,
      ),
    ).toBe('INACTIVE');
    expect(catalogueGap(product({ audience: 'HIDDEN', panelId: null }) as never)).toBe('UNLISTED');
    expect(
      catalogueGap(product({ priceAmount: null, priceCurrency: null, panelId: null }) as never),
    ).toBe('UNPRICED');
    expect(catalogueGap(product({ panelId: null }) as never)).toBe('NO_PANEL');
  });
});

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

describe('the product list', () => {
  it('renders a sellable product and says it is in the catalogue', async () => {
    stubApi(productList([product()]));
    renderPage(<ProductsPage route={PRODUCTS_ROUTE} mayEdit denied={false} />);

    expect(await screen.findByText('پلن یک‌ماهه')).toBeInTheDocument();
    expect(screen.getByText('نمایش داده می‌شود')).toBeInTheDocument();
    // The traffic allowance in binary units, from the decimal STRING on the wire.
    expect(screen.getByText('گیگابایت')).toBeInTheDocument();
    expect(screen.getByText('50')).toBeInTheDocument();
  });

  it('says WHY a product is not in the catalogue, one reason per row', async () => {
    stubApi(
      productList([
        product({ id: '019220ab-cdef-7012-8345-6789abcdef02', status: 'INACTIVE' }),
        product({ id: '019220ab-cdef-7012-8345-6789abcdef03', audience: 'HIDDEN' }),
        product({
          id: '019220ab-cdef-7012-8345-6789abcdef04',
          priceAmount: null,
          priceCurrency: null,
        }),
        product({ id: '019220ab-cdef-7012-8345-6789abcdef05', panelId: null }),
      ]),
    );
    renderPage(<ProductsPage route={PRODUCTS_ROUTE} mayEdit denied={false} />);

    // Four DIFFERENT sentences. A single "not visible" would leave an operator to
    // discover which of the four it was by trial.
    expect(await screen.findByText(/غیرفعال است/)).toBeInTheDocument();
    expect(screen.getByText(/پنهان است/)).toBeInTheDocument();
    expect(screen.getByText(/قیمت ندارد/)).toBeInTheDocument();
    expect(screen.getByText(/به هیچ پنلی وصل نیست/)).toBeInTheDocument();
  });

  it('renders no price rather than a zero for an unpriced product', async () => {
    // `catalog.ts` is explicit that free is not a concept: an absent price means
    // unsellable. A rendered `0` would read as a giveaway.
    stubApi(productList([product({ priceAmount: null, priceCurrency: null })]));
    const { container } = renderPage(
      <ProductsPage route={PRODUCTS_ROUTE} mayEdit denied={false} />,
    );
    await screen.findByText('پلن یک‌ماهه');
    expect(container.textContent).not.toContain('۰ تومان');
    expect(container.querySelectorAll('.faint').length).toBeGreaterThan(0);
  });

  it('carries a price past 2^53 without losing a unit', async () => {
    // The wire form is a decimal string precisely because `Number` would round this.
    stubApi(productList([product({ priceAmount: '9007199254740993' })]));
    const { container } = renderPage(
      <ProductsPage route={PRODUCTS_ROUTE} mayEdit denied={false} />,
    );
    await screen.findByText('پلن یک‌ماهه');
    expect(container.textContent).toContain('9,007,199,254,740,993');
  });

  it('clears the search box when navigation drops the query', async () => {
    stubApi(productList([product()]));
    const searched = { path: '/products', query: new URLSearchParams({ title: 'پلن' }) };
    const { rerender } = renderPage(<ProductsPage route={searched} mayEdit denied={false} />);
    await screen.findByText('پلن یک‌ماهه');
    expect((screen.getByLabelText('عنوان محصول') as HTMLInputElement).value).toBe('پلن');

    // The sidebar link: same component instance, empty query. A `useState` initialiser
    // would leave the old criteria in the box above an unfiltered list.
    rerender(<ProductsPage route={PRODUCTS_ROUTE} mayEdit denied={false} />);
    expect((screen.getByLabelText('عنوان محصول') as HTMLInputElement).value).toBe('');
  });

  it('offers no create form to an actor without catalog.edit, and names the permission', async () => {
    stubApi(productList([product()]));
    renderPage(<ProductsPage route={PRODUCTS_ROUTE} mayEdit={false} denied={false} />);
    await screen.findByText('پلن یک‌ماهه');

    // A sentence rather than a disabled form: both make the same claim and only one
    // says which permission to ask for.
    expect(screen.getByText(/catalog\.edit/)).toBeInTheDocument();
    expect(screen.queryByLabelText('مخاطب')).toBeNull();
  });

  /** Owner revision 10, which used to be recorded on the planned products page. */
  it('records that no least-loaded panel routing will exist', async () => {
    stubApi(productList([product()]));
    const { container } = renderPage(
      <ProductsPage route={PRODUCTS_ROUTE} mayEdit denied={false} />,
    );
    await screen.findByText('پلن یک‌ماهه');
    const text = container.textContent ?? '';
    expect(text).toContain('کم‌بارترین پنل');
    expect(text).toContain('وجود نخواهد داشت');
    expect(text).toContain('مشتری');
  });
});

describe('the product form', () => {
  const formFor = (overrides: Record<string, unknown> = {}) => {
    const api = stubApi([
      { url: '/products/019220ab', body: { product: product(overrides) } },
      { url: '/panels', body: { panels: [panel()], nextCursor: null } },
      { url: '/products', body: { products: [product(overrides)], nextCursor: null } },
    ]);
    renderPage(
      <ProductDetailPage id="019220ab-cdef-7012-8345-6789abcdef01" mayEdit denied={false} />,
    );
    return api;
  };

  it('sends the price PAIR together, and both halves absent when the box is empty', async () => {
    const api = formFor();
    const price = (await screen.findByLabelText('قیمت')) as HTMLInputElement;
    fireEvent.change(price, { target: { value: '' } });
    fireEvent.click(screen.getByText('ذخیرهٔ تغییرات'));

    await waitFor(() => {
      const write = api.calls.find((call) => call.method === 'POST');
      expect(write).toBeDefined();
      const body = write?.body as Record<string, unknown>;
      // Both null. An amount without a currency is the shape the schema, the service
      // and a CHECK constraint each refuse, and this is the layer that could mint one.
      expect(body['priceAmount']).toBeNull();
      expect(body['priceCurrency']).toBeNull();
    });
  });

  it('refuses a zero price in the browser, naming the field', async () => {
    formFor();
    const price = (await screen.findByLabelText('قیمت')) as HTMLInputElement;
    fireEvent.change(price, { target: { value: '0' } });

    // Named here rather than left to the server's 400, which an operator reads as
    // "something is wrong" without saying which box.
    expect(
      await screen.findByText(/قیمت باید عددی صحیح و بزرگ‌تر از صفر باشد/),
    ).toBeInTheDocument();
    expect((screen.getByText('ذخیرهٔ تغییرات') as HTMLButtonElement).disabled).toBe(true);
  });

  it('refuses an empty title', async () => {
    formFor();
    const title = (await screen.findByLabelText('عنوان')) as HTMLInputElement;
    fireEvent.change(title, { target: { value: '   ' } });
    expect(await screen.findByText('عنوان نمی‌تواند خالی باشد.')).toBeInTheDocument();
  });

  it('says a new product is created INACTIVE, where the button is', async () => {
    stubApi(productList([]));
    renderPage(<ProductsPage route={PRODUCTS_ROUTE} mayEdit denied={false} />);
    // The one thing about this form that surprises: creating does not publish. Said
    // ONCE — two sentences making the same point is how a page stops being read.
    expect(await screen.findByText(/غیرفعال ساخته می‌شود تا یک دکمه نتواند/)).toBeInTheDocument();
  });
});

describe('the product detail', () => {
  it('offers Activate for a withdrawn product and Deactivate for a live one', async () => {
    stubApi([
      { url: '/products/019220ab', body: { product: product({ status: 'INACTIVE' }) } },
      { url: '/panels', body: { panels: [panel()], nextCursor: null } },
    ]);
    renderPage(
      <ProductDetailPage id="019220ab-cdef-7012-8345-6789abcdef01" mayEdit denied={false} />,
    );
    expect(await screen.findByText('فعال کردن')).toBeInTheDocument();
    expect(screen.queryByText('غیرفعال کردن')).toBeNull();
  });

  it('says a withdrawal does not touch existing orders', async () => {
    stubApi([
      { url: '/products/019220ab', body: { product: product() } },
      { url: '/panels', body: { panels: [panel()], nextCursor: null } },
    ]);
    const { container } = renderPage(
      <ProductDetailPage id="019220ab-cdef-7012-8345-6789abcdef01" mayEdit denied={false} />,
    );
    await screen.findByText('غیرفعال کردن');
    // The sentence that stops a withdrawal being feared — and it is true because of
    // the order snapshot, which the orders suite asserts as behaviour.
    expect(container.textContent).toContain('نسخهٔ خودش از محصول را نگه داشته است');
  });
});

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

describe('the order list', () => {
  it('renders the SNAPSHOT title, not a product lookup', async () => {
    stubApi(orderList([order({ lineTitle: 'نامی که دیگر وجود ندارد' })]));
    renderPage(<OrdersPage route={ORDERS_ROUTE} denied={false} />);
    // The legacy «محصول حذف‌شده» is what a screen that joined on today's product row
    // shows for anything since renamed. This screen cannot: it renders what was bought.
    expect(await screen.findByText('نامی که دیگر وجود ندارد')).toBeInTheDocument();
  });

  it('offers every frozen state as a filter, including the two nothing can reach yet', async () => {
    stubApi(orderList([order()]));
    renderPage(<OrdersPage route={ORDERS_ROUTE} denied={false} />);
    await screen.findByText('پلن یک‌ماهه');

    // `PAID` and `REFUNDED` need a payment. The filter offers them because an operator
    // who filters for "paid" and sees nothing has been told something true, while a
    // missing option leaves them wondering whether the product has the concept.
    for (const label of [
      'پیش‌نویس',
      'در انتظار پرداخت',
      'پرداخت‌شده',
      'لغوشده',
      'منقضی‌شده',
      'بازپرداخت‌شده',
    ]) {
      expect(screen.getAllByText(label).length, label).toBeGreaterThan(0);
    }
  });

  it('presses every control it has and still issues nothing but reads', async () => {
    const api = stubApi(orderList([order({ state: 'AWAITING_PAYMENT' })]));
    const { container } = renderPage(<OrdersPage route={ORDERS_ROUTE} denied={false} />);
    await screen.findByText('پلن یک‌ماهه');

    /*
     * Asserted as REQUESTS, not as button labels.
     *
     * A label check is both too weak and too strong here: the state filter offers
     * «لغوشده», which contains the word "cancel", while a real mark-paid button could
     * be called anything at all. What cannot be argued with is the wire — this page has
     * no write route to call, so pressing everything it draws must leave the method
     * column reading GET all the way down. A mark-paid, cancel or refund control added
     * later fails this the moment it is wired to anything.
     */
    for (const button of container.querySelectorAll('button')) fireEvent.click(button);
    await waitFor(() => expect(api.calls.length).toBeGreaterThan(0));
    expect(api.calls.map((call) => call.method)).toEqual(api.calls.map(() => 'GET'));
  });

  /** Owner revisions 3, 6 and 11, which used to be recorded on the planned orders page. */
  it('records the needs-attention, history and shared-projection rules', async () => {
    stubApi(orderList([order()]));
    const { container } = renderPage(<OrdersPage route={ORDERS_ROUTE} denied={false} />);
    await screen.findByText('پلن یک‌ماهه');
    const text = container.textContent ?? '';
    expect(text).toContain('نیازمند توجه');
    expect(text).toContain('تاریخچهٔ واقعی سفارش');
    expect(text).toContain('پروجکشن مشترک');
  });
});

describe('the order detail', () => {
  const detail = (overrides: Record<string, unknown> = {}) => {
    stubApi([{ url: '/orders/019230ab', body: { order: order(overrides) } }]);
    return renderPage(<OrderDetailPage id="019230ab-cdef-7012-8345-6789abcdef01" denied={false} />);
  };

  it('says the order is waiting for a payment this release cannot take', async () => {
    const { container } = detail({
      state: 'AWAITING_PAYMENT',
      confirmedAt: '2026-09-10T12:35:00.000Z',
    });
    expect(await screen.findByText('این سفارش منتظر پرداخت است')).toBeInTheDocument();
    // Saying so is the alternative to a button that would pretend.
    expect(container.textContent).toContain('راهی برای دریافت پرداخت وجود ندارد');
  });

  it('shows the snapshot and the totals, and marks them as a snapshot', async () => {
    const { container } = detail();
    // Twice on purpose — the page head's subtitle and the snapshot card — so the
    // ALL-variant is the correct query rather than a looser one.
    expect((await screen.findAllByText('پلن یک‌ماهه')).length).toBeGreaterThan(1);
    expect(container.textContent).toContain('در لحظهٔ ثبت سفارش نگه داشته شده‌اند');
    // Subtotal, discount and total all rendered — a page that showed only the total
    // could not answer "why this number".
    expect(screen.getByText('جمع')).toBeInTheDocument();
    expect(screen.getByText('تخفیف')).toBeInTheDocument();
    expect(screen.getByText('مبلغ نهایی')).toBeInTheDocument();
  });

  it('labels the product and customer links as navigation, not as the record', async () => {
    const { container } = detail();
    await screen.findAllByText('پلن یک‌ماهه');
    expect(container.textContent).toContain('آنچه خریداری شده از همین سفارش خوانده می‌شود');
  });
});

// ---------------------------------------------------------------------------
// Routing and permissions
// ---------------------------------------------------------------------------

describe('the two routes', () => {
  it('serves the real pages, not the planned placeholder', () => {
    stubApi([
      { url: '/products', body: { products: [], nextCursor: null } },
      { url: '/panels', body: { panels: [], nextCursor: null } },
      { url: '/orders', body: { orders: [], nextCursor: null } },
    ]);
    for (const path of ['/products', '/orders']) {
      const resolved = resolve({ path, query: new URLSearchParams() }, [
        'catalog.view',
        'catalog.edit',
        'orders.view',
      ]);
      const view = renderPage(resolved.element as ReactElement);
      expect(within(view.container).queryByText('چرا هنوز فعال نیست'), path).toBeNull();
      view.unmount();
    }
  });

  it('refuses the list to an actor holding no catalog or order permission', async () => {
    stubApi(productList([product()]));
    const resolved = resolve({ path: '/products', query: new URLSearchParams() }, []);
    const view = renderPage(resolved.element as ReactElement);
    // `denied` is computed from the permission, so the page asks the server nothing.
    await waitFor(() => {
      expect(within(view.container).queryByText('پلن یک‌ماهه')).toBeNull();
    });
  });
});
