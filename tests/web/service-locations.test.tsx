import { describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { ServiceLocationsPage } from '../../apps/web/src/pages/service-locations';
import { resolve } from '../../apps/web/src/app';
import { t } from '../../apps/web/src/i18n/web.fa';
import { panel, product, renderPage, stubApi } from './harness';

/**
 * The service location change's configuration (WP-A6), in Persian, under the catalogue's
 * own two permissions.
 *
 * What these cases protect is what an operator can get wrong without noticing: selling a
 * move that is free by omission, writing a limit without its period, being told nothing
 * about a panel that cannot move an account, or being shown write controls the server
 * will refuse.
 */

const INITIAL = {
  id: '019250ab-cdef-7012-8345-6789abcdef91',
  panelId: String(panel()['id']),
  productId: null,
  locationKey: 'de-1',
  label: 'آلمان',
  initial: true,
  enabled: false,
  priceAmount: null,
  priceCurrency: null,
  cooldownHours: null,
  maxChanges: null,
  periodDays: null,
  sortOrder: 0,
  version: 1,
  createdAt: '2026-09-10T12:30:00.000Z',
  updatedAt: '2026-09-11T12:30:00.000Z',
};

const TARGET = {
  ...INITIAL,
  id: '019250ab-cdef-7012-8345-6789abcdef92',
  locationKey: 'nl-1',
  label: 'هلند',
  initial: false,
  enabled: true,
  priceAmount: '0',
  priceCurrency: 'IRT',
  cooldownHours: 24,
  maxChanges: 2,
  periodDays: 30,
  version: 3,
};

const routes = (locations: unknown[] = [INITIAL, TARGET]) => [
  { url: '/service-locations', body: { locations } },
  { url: '/panels', body: { panels: [panel()], nextCursor: null } },
  { url: '/products', body: { products: [product()], nextCursor: null } },
];

describe('the service location screen', () => {
  it('lists the locations, the initial one, free and the limits, and says no panel can move one', async () => {
    stubApi(routes());
    const { container } = renderPage(<ServiceLocationsPage denied={false} mayEdit={false} />);
    await screen.findByText('هلند');

    expect(container.textContent).toContain('آلمان');
    expect(container.textContent).toContain('اولیه');
    expect(container.textContent).toContain('رایگان');
    expect(container.textContent).toContain('24 ساعت فاصله');
    expect(container.textContent).toContain('2 تغییر در 30 روز');
    // Derived from the adapters' declared capabilities: none declares it.
    expect(container.textContent).toContain('هیچ‌یک از انواع پنل پشتیبانی‌شده');
    // A view-only role is given no write control at all.
    expect(container.textContent).not.toContain('لوکیشن جدید');
    expect(container.textContent).not.toContain('ویرایش');
    cleanup();
  });

  it('writes a priced target, and never an enabled one without a price', async () => {
    const api = stubApi(routes([]));
    renderPage(<ServiceLocationsPage denied={false} mayEdit />);
    await screen.findByText('لوکیشن جدید');
    // The panel list marks a panel whose adapter cannot move an account.
    await screen.findByText(/این پنل تغییر لوکیشن را پشتیبانی نمی‌کند/u);

    fireEvent.change(screen.getByLabelText('پنل'), { target: { value: String(panel()['id']) } });
    fireEvent.change(screen.getByLabelText('نام لوکیشن'), { target: { value: 'هلند' } });
    fireEvent.change(screen.getByLabelText('شناسهٔ لوکیشن در پنل'), { target: { value: 'nl-1' } });
    fireEvent.click(screen.getByLabelText('به‌عنوان مقصد به مشتری عرضه شود'));
    // Enabled and unpriced is refused before it is sent: unconfigured is never free.
    expect((screen.getByText('ذخیره') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('هزینهٔ انتقال'), { target: { value: '30000' } });
    fireEvent.change(screen.getByLabelText('فاصلهٔ لازم بین دو تغییر (ساعت)'), {
      target: { value: '12' },
    });
    fireEvent.click(screen.getByText('ذخیره'));

    await waitFor(() =>
      expect(
        api.calls.some((call) => call.method === 'POST' && call.url.endsWith('/service-locations')),
      ).toBe(true),
    );
    const write = api.calls.find((call) => call.method === 'POST')!;
    expect(write.body).toMatchObject({
      panelId: panel()['id'],
      productId: null,
      locationKey: 'nl-1',
      label: 'هلند',
      initial: false,
      enabled: true,
      priceAmount: '30000',
      priceCurrency: 'IRT',
      cooldownHours: 12,
      maxChanges: null,
      periodDays: null,
    });
    cleanup();
  });

  it('takes a rolling limit only as a number of changes AND a period', async () => {
    stubApi(routes([]));
    renderPage(<ServiceLocationsPage denied={false} mayEdit />);
    await screen.findByText('لوکیشن جدید');
    await screen.findByText(/این پنل تغییر لوکیشن را پشتیبانی نمی‌کند/u);
    fireEvent.change(screen.getByLabelText('پنل'), { target: { value: String(panel()['id']) } });
    fireEvent.change(screen.getByLabelText('نام لوکیشن'), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText('شناسهٔ لوکیشن در پنل'), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText('حداکثر تعداد تغییر'), { target: { value: '2' } });
    expect((screen.getByText('ذخیره') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('در بازهٔ چند روز'), { target: { value: '30' } });
    expect((screen.getByText('ذخیره') as HTMLButtonElement).disabled).toBe(false);
    cleanup();
  });

  it("offers only the chosen panel's products as a scope", async () => {
    const elsewhere = product({
      id: '019220ab-cdef-7012-8345-6789abcdef02',
      title: 'پلن پنل دیگر',
      panelId: '01a05e35-c9ad-7e93-bef3-1ed9b55292d9',
    });
    stubApi([
      { url: '/service-locations', body: { locations: [] } },
      { url: '/panels', body: { panels: [panel()], nextCursor: null } },
      { url: '/products', body: { products: [product(), elsewhere], nextCursor: null } },
    ]);
    renderPage(<ServiceLocationsPage denied={false} mayEdit />);
    await screen.findByText(/این پنل تغییر لوکیشن را پشتیبانی نمی‌کند/u);
    fireEvent.change(screen.getByLabelText('پنل'), { target: { value: String(panel()['id']) } });
    await screen.findByText('پلن یک‌ماهه');
    expect(screen.queryByText('پلن پنل دیگر')).toBeNull();
    cleanup();
  });

  it('gives an edit-only role a working form: the panels it may list, ids for the rest', async () => {
    // Codex review #2 on PR #101: `catalog.edit` without `catalog.view` saw an empty picker.
    const api = stubApi(routes());
    renderPage(<ServiceLocationsPage denied mayEdit mayReadPanels />);
    await screen.findByText('لوکیشن جدید');
    // `panels.view` is held, so the panel list is read and offered.
    await screen.findByText(/Frankfurt A/u);
    // `catalog.view` is not: the product list is never asked for, and its id is typed.
    expect(api.calls.some((call) => call.url.includes('/products'))).toBe(false);
    expect(screen.getByLabelText('محصول').tagName).toBe('INPUT');
    cleanup();
  });

  it('takes a typed panel id from a role that may not list panels, and never asks', async () => {
    const api = stubApi(routes());
    renderPage(<ServiceLocationsPage denied mayEdit mayReadPanels={false} />);
    await screen.findByText('لوکیشن جدید');
    expect(screen.getByLabelText('پنل').tagName).toBe('INPUT');
    expect(api.calls.some((call) => call.url.includes('/panels'))).toBe(false);
    cleanup();
  });

  it('is routed at /service-locations, under the catalogue permissions', () => {
    const route = { path: '/service-locations', query: new URLSearchParams() };
    expect(resolve(route, ['catalog.view']).title).toBe('تغییر لوکیشن سرویس');
  });
});

describe('replacing unsaved input in the location form', () => {
  it('asks before Edit or Add replaces what was typed, and not when nothing was', async () => {
    stubApi(routes());
    renderPage(<ServiceLocationsPage denied={false} mayEdit />);
    const cell = await screen.findByText('هلند', { selector: 'td *, td' });
    const edit = () =>
      within(cell.closest('tr') as HTMLElement).getByRole('button', {
        name: t('web.service_locations_edit'),
      });
    const label = () => document.getElementById('sl-label') as HTMLInputElement;
    fireEvent.change(label(), { target: { value: 'فرانسه' } });

    fireEvent.click(screen.getByRole('button', { name: t('web.cb_add') }));
    fireEvent.click(
      within(screen.getByRole('alertdialog', { name: t('web.unsaved_title') })).getByRole(
        'button',
        { name: t('web.unsaved_stay') },
      ),
    );
    expect(label().value).toBe('فرانسه');

    fireEvent.click(edit());
    fireEvent.click(
      within(screen.getByRole('alertdialog', { name: t('web.unsaved_title') })).getByRole(
        'button',
        { name: t('web.discard') },
      ),
    );
    await waitFor(() => expect(label().value).toBe('هلند'));

    fireEvent.click(screen.getByRole('button', { name: t('web.cb_add') }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(label().value).toBe(''));
  });
});
