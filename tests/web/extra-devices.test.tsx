import { describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { ExtraDevicesPage } from '../../apps/web/src/pages/extra-devices';
import { resolve } from '../../apps/web/src/app';
import { panel, product, renderPage, stubApi } from './harness';

/**
 * The extra users / devices rate (WP-A5): an `ADD_DEVICES` service add-on, configured in
 * Persian, under the catalogue's own two permissions.
 *
 * What these cases protect is what an operator can get wrong without noticing: writing a
 * rate that is not per-user, scoping it to a panel that cannot apply it without being
 * told so, or drawing write controls for a role the server will refuse.
 */

const RATE = {
  id: '019250ab-cdef-7012-8345-6789abcdef77',
  kind: 'ADD_DEVICES',
  title: 'کاربر اضافه',
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
};

const routes = (rates: unknown[] = [RATE]) => [
  { url: '/service-addons?', body: { addons: rates, nextCursor: null } },
  { url: '/service-addons', body: { addon: RATE } },
  { url: '/panels', body: { panels: [panel()], nextCursor: null } },
  { url: '/products', body: { products: [product()], nextCursor: null } },
];

describe('the extra users / devices screen', () => {
  it('lists the per-user rate, and says no panel type can apply it in this release', async () => {
    stubApi(routes());
    const { container } = renderPage(<ExtraDevicesPage denied={false} mayEdit={false} />);
    await screen.findByText('کاربر اضافه');

    expect(container.textContent).toContain('قیمت هر کاربر');
    expect(container.textContent).toContain('حداکثر قابل خرید');
    // Derived from the adapters' declared capabilities: none declares it.
    expect(container.textContent).toContain('هیچ‌یک از انواع پنل پشتیبانی‌شده');
    // A view-only role is given no write control at all.
    expect(container.textContent).not.toContain('تعرفهٔ جدید');
    expect(container.textContent).not.toContain('ویرایش');
    cleanup();
  });

  it('writes an ADD_DEVICES rate with a per-user price, a maximum and a scope', async () => {
    const api = stubApi(routes([]));
    renderPage(<ExtraDevicesPage denied={false} mayEdit />);
    await screen.findByText('تعرفهٔ جدید');
    // The panel list marks a panel whose adapter cannot raise a limit.
    await screen.findByText(/این پنل افزایش کاربر را پشتیبانی نمی‌کند/u);

    fireEvent.change(screen.getByLabelText('عنوان'), { target: { value: 'کاربر اضافه' } });
    fireEvent.change(screen.getByLabelText('قیمت هر کاربر'), { target: { value: '50000' } });
    fireEvent.change(screen.getByLabelText('حداکثر قابل خرید'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('پنل'), {
      target: { value: String(panel()['id']) },
    });
    fireEvent.click(screen.getByText('ذخیره'));

    await waitFor(() =>
      expect(
        api.calls.some((call) => call.method === 'POST' && call.url.endsWith('/service-addons')),
      ).toBe(true),
    );
    const write = api.calls.find((call) => call.method === 'POST')!;
    expect(write.body).toMatchObject({
      kind: 'ADD_DEVICES',
      title: 'کاربر اضافه',
      priceAmount: '50000',
      priceCurrency: 'IRT',
      maxQuantity: 4,
      trafficGb: null,
      durationDays: null,
      panelId: panel()['id'],
      productId: null,
    });
    cleanup();
  });

  it('refuses to save a maximum outside what one service may be sold', async () => {
    stubApi(routes([]));
    renderPage(<ExtraDevicesPage denied={false} mayEdit />);
    await screen.findByText('تعرفهٔ جدید');
    fireEvent.change(screen.getByLabelText('عنوان'), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText('قیمت هر کاربر'), { target: { value: '1000' } });
    fireEvent.change(screen.getByLabelText('حداکثر قابل خرید'), { target: { value: '21' } });
    expect((screen.getByText('ذخیره') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('حداکثر قابل خرید'), { target: { value: '0' } });
    expect((screen.getByText('ذخیره') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('حداکثر قابل خرید'), { target: { value: '20' } });
    expect((screen.getByText('ذخیره') as HTMLButtonElement).disabled).toBe(false);
    cleanup();
  });

  it('walks the rate list by its cursor, so a rate past the first page is reachable', async () => {
    /*
     * Codex review #1 on PR #97, C2: the page read the first hundred and ignored
     * `nextCursor`, so a later rate could be created and never seen or edited again.
     */
    const later = { ...RATE, id: '019250ab-cdef-7012-8345-6789abcdef78', title: 'تعرفهٔ دوم' };
    const api = stubApi([
      { url: '/service-addons?limit=50&kind', body: { addons: [RATE], nextCursor: 'c-2' } },
      { url: '/service-addons?limit=50&cursor=c-2', body: { addons: [later], nextCursor: null } },
      { url: '/panels', body: { panels: [panel()], nextCursor: null } },
      { url: '/products', body: { products: [product()], nextCursor: null } },
    ]);
    renderPage(<ExtraDevicesPage denied={false} mayEdit={false} />);
    await screen.findByText('کاربر اضافه');
    expect(screen.queryByText('تعرفهٔ دوم')).toBeNull();

    fireEvent.click(screen.getByText('تازه‌تر'));
    await screen.findByText('تعرفهٔ دوم');
    expect(api.calls.some((call) => call.url.includes('cursor=c-2'))).toBe(true);
    expect(screen.queryByText('کاربر اضافه')).toBeNull();

    // And back, to exactly the page it came from.
    fireEvent.click(screen.getByText('قدیمی‌تر'));
    await screen.findByText('کاربر اضافه');
    cleanup();
  });

  it('offers every panel and product as a scope, past the first page of either', async () => {
    const far = panel({ id: '01a05e35-c9ad-7e93-bef3-1ed9b55292d9', name: 'Tehran Z' });
    stubApi([
      { url: '/service-addons?', body: { addons: [], nextCursor: null } },
      { url: '/panels?limit=100', body: { panels: [panel()], nextCursor: 'p-2' } },
      { url: '/panels?limit=100&cursor=p-2', body: { panels: [far], nextCursor: null } },
      { url: '/products', body: { products: [product()], nextCursor: null } },
    ]);
    renderPage(<ExtraDevicesPage denied={false} mayEdit />);
    await screen.findByText(/Tehran Z/u);
    cleanup();
  });

  it('is routed at /extra-devices, under the catalogue permissions', () => {
    const route = { path: '/extra-devices', query: new URLSearchParams() };
    const viewer = resolve(route, ['catalog.view']);
    expect(viewer.title).toBe('افزایش کاربر / دستگاه');
  });
});
