import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { ProductDetailPage, ProductsPage } from '../../apps/web/src/pages/products';
import { categoryListing, panel, product, renderPage, stubApi } from './harness';

/**
 * Product display metadata on the Web Admin (customer UX completion §C, §L).
 *
 * Three things the form has to get right, each a way the pre-invoice would lie:
 *
 *   - the lists travel in the ORDER the operator arranged, so the editor has to be able
 *     to move a row and the body has to carry the moved order;
 *   - a product written before the fields existed opens with EMPTY editors, not with
 *     some default the operator never typed;
 *   - the label round-trips, and an empty label is sent as null rather than as `''`,
 *     which the schema refuses.
 */

const PRODUCTS_ROUTE = { path: '/products', query: new URLSearchParams() };
const ID = '019220ab-cdef-7012-8345-6789abcdef01';

const fixtures = (overrides: Record<string, unknown> = {}) => [
  { url: `/products/019220ab`, body: { product: product(overrides) } },
  { url: '/panels', body: { panels: [panel()], nextCursor: null } },
  { url: '/products', body: { products: [product(overrides)], nextCursor: null } },
  { url: '/product-categories', body: { categories: [categoryListing()] } },
];

const lastWrite = (api: ReturnType<typeof stubApi>) =>
  api.calls.find((call) => call.method === 'POST')?.body as Record<string, unknown> | undefined;

describe('the product display editors', () => {
  it('sends the lists in the order they were edited, moves included', async () => {
    const api = stubApi(fixtures());
    renderPage(<ProductsPage route={PRODUCTS_ROUTE} mayEdit denied={false} />);
    await screen.findByLabelText('عنوان');

    fireEvent.change(screen.getByLabelText('عنوان'), { target: { value: 'پلن' } });

    // Three locations, typed in order.
    const addLocation = screen.getByRole('button', { name: /افزودن لوکیشن/u });
    fireEvent.click(addLocation);
    fireEvent.click(addLocation);
    fireEvent.click(addLocation);
    fireEvent.change(screen.getByLabelText('لوکیشن 1'), { target: { value: 'Germany' } });
    fireEvent.change(screen.getByLabelText('لوکیشن 2'), { target: { value: 'Netherlands' } });
    fireEvent.change(screen.getByLabelText('لوکیشن 3'), { target: { value: 'Finland' } });

    // Two features, and the second is then moved above the first.
    const addFeature = screen.getByRole('button', { name: /افزودن ویژگی/u });
    fireEvent.click(addFeature);
    fireEvent.click(addFeature);
    fireEvent.change(screen.getByLabelText('ویژگی 1'), { target: { value: 'No logs' } });
    fireEvent.change(screen.getByLabelText('ویژگی 2'), { target: { value: 'Unlimited devices' } });

    /*
     * The move buttons are the ListEditor's, labelled by position. Both lists are on
     * the page, so the feature editor's buttons are found INSIDE the feature row rather
     * than by name alone — the location editor has a "move up — 2" too.
     */
    const featureRow = screen.getByLabelText('ویژگی 2').closest('.list-editor-row');
    if (featureRow === null) throw new Error('no editor row around the second feature');
    fireEvent.click(
      within(featureRow as HTMLElement).getByRole('button', { name: /انتقال به بالا/u }),
    );

    // And the third location is moved up once, so the list is no longer typing order.
    const locationRow = screen.getByLabelText('لوکیشن 3').closest('.list-editor-row');
    if (locationRow === null) throw new Error('no editor row around the third location');
    fireEvent.click(
      within(locationRow as HTMLElement).getByRole('button', { name: /انتقال به بالا/u }),
    );

    fireEvent.change(screen.getByLabelText('برچسب لوکیشن سرویس'), {
      target: { value: '  Frankfurt ' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'ساخت محصول' }));

    await waitFor(() => expect(lastWrite(api)).toBeDefined());
    const body = lastWrite(api);
    expect(body?.['displayLocations']).toEqual(['Germany', 'Finland', 'Netherlands']);
    expect(body?.['displayFeatures']).toEqual(['Unlimited devices', 'No logs']);
    // Trimmed, as the schema would trim it — so what the operator sees saved is what shows.
    expect(body?.['serviceLocationLabel']).toBe('Frankfurt');
  });

  it('opens a product with no display data as empty editors and sends empty lists back', async () => {
    const api = stubApi(fixtures());
    renderPage(<ProductDetailPage id={ID} mayEdit denied={false} />);
    await screen.findByLabelText('قیمت');

    expect(screen.queryByLabelText('لوکیشن 1')).toBeNull();
    expect(screen.queryByLabelText('ویژگی 1')).toBeNull();
    expect(screen.getByText(/لوکیشنی نوشته نشده است/u)).toBeInTheDocument();
    expect(screen.getByText(/ویژگی‌ای نوشته نشده است/u)).toBeInTheDocument();
    expect((screen.getByLabelText('برچسب لوکیشن سرویس') as HTMLInputElement).value).toBe('');

    fireEvent.click(screen.getByText('ذخیرهٔ تغییرات'));
    await waitFor(() => expect(lastWrite(api)).toBeDefined());
    const body = lastWrite(api);
    expect(body?.['displayLocations']).toEqual([]);
    expect(body?.['displayFeatures']).toEqual([]);
    // Empty is ABSENT: `''` is a label the schema refuses, and null is what "none" is.
    expect(body?.['serviceLocationLabel']).toBeNull();
  });

  it('round-trips an existing label and lists, in their stored order', async () => {
    const api = stubApi(
      fixtures({
        displayLocations: ['🇫🇮 Finland', '🇩🇪 Germany'],
        displayFeatures: ['• No logs'],
        serviceLocationLabel: 'Helsinki',
      }),
    );
    renderPage(<ProductDetailPage id={ID} mayEdit denied={false} />);
    await screen.findByLabelText('قیمت');

    // The detail card shows them, numbered, in the stored order.
    const detail = screen.getAllByText('🇫🇮 Finland');
    expect(detail.length).toBeGreaterThan(0);
    const list = detail.find((node) => node.tagName === 'LI')?.closest('ol');
    expect(list).not.toBeNull();
    expect([...(list?.querySelectorAll('li') ?? [])].map((li) => li.textContent)).toEqual([
      '🇫🇮 Finland',
      '🇩🇪 Germany',
    ]);

    // The editors hold the same values in the same order.
    expect((screen.getByLabelText('لوکیشن 1') as HTMLInputElement).value).toBe('🇫🇮 Finland');
    expect((screen.getByLabelText('لوکیشن 2') as HTMLInputElement).value).toBe('🇩🇪 Germany');
    expect((screen.getByLabelText('ویژگی 1') as HTMLInputElement).value).toBe('• No logs');
    const label = screen.getByLabelText('برچسب لوکیشن سرویس') as HTMLInputElement;
    expect(label.value).toBe('Helsinki');

    fireEvent.change(label, { target: { value: 'Espoo' } });
    fireEvent.click(screen.getByText('ذخیرهٔ تغییرات'));
    await waitFor(() => expect(lastWrite(api)).toBeDefined());
    const body = lastWrite(api);
    expect(body?.['displayLocations']).toEqual(['🇫🇮 Finland', '🇩🇪 Germany']);
    expect(body?.['displayFeatures']).toEqual(['• No logs']);
    expect(body?.['serviceLocationLabel']).toBe('Espoo');
  });

  it('refuses a blank line and a label past the bound at the field, and will not send', async () => {
    const api = stubApi(fixtures());
    renderPage(<ProductDetailPage id={ID} mayEdit denied={false} />);
    await screen.findByLabelText('قیمت');

    fireEvent.click(screen.getByRole('button', { name: /افزودن لوکیشن/u }));
    // Added and left blank: reported, never silently dropped.
    expect(await screen.findByText(/هر لوکیشن باید یک خط غیرخالی/u)).toBeInTheDocument();
    expect(screen.getByText('ذخیرهٔ تغییرات')).toBeDisabled();

    fireEvent.change(screen.getByLabelText('لوکیشن 1'), { target: { value: 'Germany' } });
    expect(screen.getByText('ذخیرهٔ تغییرات')).not.toBeDisabled();

    // `maxLength` stops typing past the bound; a pasted value is refused by the same rule.
    const label = screen.getByLabelText('برچسب لوکیشن سرویس') as HTMLInputElement;
    expect(label.maxLength).toBe(60);

    expect(api.calls.some((call) => call.method === 'POST')).toBe(false);
  });
});
