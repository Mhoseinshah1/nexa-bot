import { describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import {
  ExtraPackagesPage,
  daysAmountOf,
  trafficAmountOf,
} from '../../apps/web/src/pages/extra-packages';
import { resolve } from '../../apps/web/src/app';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * «حجم، زمان و کاربر اضافه» (Round 4 B6): the traffic and time packages beside the user rate.
 * What these protect: a package written with the amount in the wrong field (the contract
 * refuses it, but an operator would only learn after the click), a scope or a maximum offered
 * where the contract forbids them, and write controls drawn for a role that may only view.
 */

const GIB = 1024n ** 3n;

const addon = (over: Record<string, unknown>) => ({
  id: '019250ab-cdef-7012-8345-6789abcdef10',
  kind: 'ADD_TRAFFIC',
  title: 'ده گیگ',
  status: 'ACTIVE',
  sortOrder: 0,
  trafficBytes: String(10n * GIB),
  durationDays: null,
  maxQuantity: null,
  panelId: null,
  productId: null,
  version: 1,
  priceAmount: '90000',
  priceCurrency: 'IRT',
  createdAt: '2026-09-10T12:30:00.000Z',
  updatedAt: '2026-09-11T12:30:00.000Z',
  ...over,
});

const TRAFFIC = addon({});
const TIME = addon({
  id: '019250ab-cdef-7012-8345-6789abcdef11',
  kind: 'ADD_TIME',
  title: 'سی روز',
  trafficBytes: null,
  durationDays: 30,
  priceAmount: '120000',
});

const routes = () => [
  { url: 'kind=ADD_TRAFFIC', body: { addons: [TRAFFIC], nextCursor: null } },
  { url: 'kind=ADD_TIME', body: { addons: [TIME], nextCursor: null } },
  { url: 'kind=ADD_DEVICES', body: { addons: [], nextCursor: null } },
  { url: '/service-addons', method: 'POST', body: { addon: TRAFFIC } },
  { url: '/panels', body: { panels: [], nextCursor: null } },
  { url: '/products', body: { products: [], nextCursor: null } },
];

const page = (tab: string | null, mayEdit = true) => (
  <ExtraPackagesPage
    route={{
      path: '/extra-devices',
      query: new URLSearchParams(tab === null ? '' : `tab=${tab}`),
    }}
    denied={false}
    mayEdit={mayEdit}
  />
);

describe('the extra packages page', () => {
  it('opens on the traffic tab and lists GB packages with their hand-typed price', async () => {
    const api = stubApi(routes());
    const { container } = renderPage(page(null));
    await screen.findByText('ده گیگ');
    expect(container.textContent).toContain(t('web.extra_packages_title'));
    expect(container.textContent).toContain(t('web.unit_gib'));
    expect(api.calls.some((call) => call.url.includes('kind=ADD_TRAFFIC'))).toBe(true);
    // The old bot's prices are never read: nothing but /service-addons is asked for.
    expect(api.calls.every((call) => call.url.includes('/service-addons'))).toBe(true);
    cleanup();
  });

  it('lists day packages on the time tab', async () => {
    const api = stubApi(routes());
    const { container } = renderPage(page('time'));
    await screen.findByText('سی روز');
    expect(container.textContent).toContain(t('web.unit_days'));
    expect(api.calls.some((call) => call.url.includes('kind=ADD_TIME'))).toBe(true);
    cleanup();
  });

  it('keeps the user rate as the third tab', async () => {
    const api = stubApi(routes());
    renderPage(page('devices'));
    await screen.findByText(t('web.extra_devices_empty'));
    expect(api.calls.some((call) => call.url.includes('kind=ADD_DEVICES'))).toBe(true);
    cleanup();
  });

  it('writes an ADD_TRAFFIC package: GB in trafficGb, no days, no scope, no maximum', async () => {
    const api = stubApi(routes());
    renderPage(page(null));
    await screen.findByText('ده گیگ');
    fireEvent.click(screen.getByRole('button', { name: t('web.cb_add') }));
    await screen.findByText(t('web.extra_packages_new'));
    // Neither a scope nor a maximum is offered on a package.
    expect(screen.queryByLabelText(t('web.extra_devices_scope_panel'))).toBeNull();
    expect(screen.queryByLabelText(t('web.extra_devices_max_quantity'))).toBeNull();

    fireEvent.change(screen.getByLabelText(t('web.extra_devices_rate_title')), {
      target: { value: 'پنج گیگ' },
    });
    fireEvent.change(screen.getByLabelText(t('web.extra_packages_amount_gb')), {
      target: { value: '2.5' },
    });
    fireEvent.change(screen.getByLabelText(t('web.extra_packages_price')), {
      target: { value: '45000' },
    });
    fireEvent.click(screen.getByText(t('web.extra_devices_save')));

    await waitFor(() => expect(api.calls.some((call) => call.method === 'POST')).toBe(true));
    expect(api.calls.find((call) => call.method === 'POST')!.body).toMatchObject({
      kind: 'ADD_TRAFFIC',
      title: 'پنج گیگ',
      trafficGb: '2.5',
      durationDays: null,
      maxQuantity: null,
      panelId: null,
      productId: null,
      priceAmount: '45000',
      priceCurrency: 'IRT',
    });
    cleanup();
  });

  it('offers a «فعال» switch, ON by default, and sends it on create (D2)', async () => {
    const api = stubApi(routes());
    renderPage(page(null));
    await screen.findByText('ده گیگ');
    fireEvent.click(screen.getByRole('button', { name: t('web.cb_add') }));
    await screen.findByText(t('web.extra_packages_new'));
    const sw = screen.getByRole('switch', { name: t('web.extra_packages_active') });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    const fill = () => {
      fireEvent.change(screen.getByLabelText(t('web.extra_devices_rate_title')), {
        target: { value: 'پنج گیگ' },
      });
      fireEvent.change(screen.getByLabelText(t('web.extra_packages_amount_gb')), {
        target: { value: '5' },
      });
      fireEvent.change(screen.getByLabelText(t('web.extra_packages_price')), {
        target: { value: '45000' },
      });
    };
    fill();
    fireEvent.click(screen.getByText(t('web.extra_devices_save')));
    await waitFor(() => expect(api.calls.some((call) => call.method === 'POST')).toBe(true));
    expect(api.calls.find((call) => call.method === 'POST')!.body).toMatchObject({ active: true });
    cleanup();
  });

  it('sends active: false when the operator switches it off', async () => {
    const api = stubApi(routes());
    renderPage(page(null));
    await screen.findByText('ده گیگ');
    fireEvent.click(screen.getByRole('button', { name: t('web.cb_add') }));
    await screen.findByText(t('web.extra_packages_new'));
    fireEvent.click(screen.getByRole('switch', { name: t('web.extra_packages_active') }));
    fireEvent.change(screen.getByLabelText(t('web.extra_devices_rate_title')), {
      target: { value: 'پنج گیگ' },
    });
    fireEvent.change(screen.getByLabelText(t('web.extra_packages_amount_gb')), {
      target: { value: '5' },
    });
    fireEvent.change(screen.getByLabelText(t('web.extra_packages_price')), {
      target: { value: '45000' },
    });
    fireEvent.click(screen.getByText(t('web.extra_devices_save')));
    await waitFor(() => expect(api.calls.some((call) => call.method === 'POST')).toBe(true));
    expect(api.calls.find((call) => call.method === 'POST')!.body).toMatchObject({ active: false });
    cleanup();
  });

  it('mints a new idempotency key when «فعال» is flipped after an ambiguous failure (Codex on #307)', async () => {
    const api = stubApi([
      ...routes().filter((route) => route.method !== 'POST'),
      { url: '/service-addons', method: 'POST', status: 503, body: { error: { code: 'x' } } },
    ]);
    renderPage(page(null));
    await screen.findByText('ده گیگ');
    fireEvent.click(screen.getByRole('button', { name: t('web.cb_add') }));
    await screen.findByText(t('web.extra_packages_new'));
    fireEvent.change(screen.getByLabelText(t('web.extra_devices_rate_title')), {
      target: { value: 'پنج گیگ' },
    });
    fireEvent.change(screen.getByLabelText(t('web.extra_packages_amount_gb')), {
      target: { value: '5' },
    });
    fireEvent.change(screen.getByLabelText(t('web.extra_packages_price')), {
      target: { value: '45000' },
    });
    const posts = () => api.calls.filter((call) => call.method === 'POST');
    fireEvent.click(screen.getByText(t('web.extra_devices_save')));
    await waitFor(() => expect(posts()).toHaveLength(1));
    fireEvent.click(screen.getByRole('switch', { name: t('web.extra_packages_active') }));
    fireEvent.click(screen.getByText(t('web.extra_devices_save')));
    await waitFor(() => expect(posts()).toHaveLength(2));
    const [first, second] = posts().map(
      (call) => call.body as { active: boolean; idempotencyKey: string },
    );
    expect(first!.active).toBe(true);
    expect(second!.active).toBe(false);
    // A different command under the same key would be refused (or replayed) by the server.
    expect(second!.idempotencyKey).not.toBe(first!.idempotencyKey);
    cleanup();
  });

  it('warns on an inactive row that the bot does not show it, and draws no switch on edit', async () => {
    stubApi([
      {
        url: 'kind=ADD_TRAFFIC',
        body: { addons: [addon({ status: 'INACTIVE' })], nextCursor: null },
      },
      ...routes().slice(1),
    ]);
    renderPage(page(null));
    await screen.findByText('ده گیگ');
    expect(screen.getByText('غیرفعال است؛ در ربات نمایش داده نمی‌شود')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t('web.extra_devices_edit') }));
    await screen.findByText(t('web.extra_packages_editing'));
    expect(screen.queryByRole('switch', { name: t('web.extra_packages_active') })).toBeNull();
    cleanup();
  });

  it('writes an ADD_TIME package: days in durationDays and no traffic', async () => {
    const api = stubApi(routes());
    renderPage(page('time'));
    await screen.findByText('سی روز');
    fireEvent.click(screen.getByRole('button', { name: t('web.cb_add') }));
    await screen.findByText(t('web.extra_packages_new'));
    fireEvent.change(screen.getByLabelText(t('web.extra_devices_rate_title')), {
      target: { value: 'هفت روز' },
    });
    fireEvent.change(screen.getByLabelText(t('web.extra_packages_amount_days')), {
      target: { value: '7' },
    });
    fireEvent.change(screen.getByLabelText(t('web.extra_packages_price')), {
      target: { value: '30000' },
    });
    fireEvent.click(screen.getByText(t('web.extra_devices_save')));
    await waitFor(() => expect(api.calls.some((call) => call.method === 'POST')).toBe(true));
    expect(api.calls.find((call) => call.method === 'POST')!.body).toMatchObject({
      kind: 'ADD_TIME',
      trafficGb: null,
      durationDays: 7,
      maxQuantity: null,
    });
    cleanup();
  });

  it('refuses to save a zero or malformed amount or a missing price', async () => {
    stubApi(routes());
    renderPage(page(null));
    await screen.findByText('ده گیگ');
    fireEvent.click(screen.getByRole('button', { name: t('web.cb_add') }));
    await screen.findByText(t('web.extra_packages_new'));
    const save = () => screen.getByText(t('web.extra_devices_save')) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText(t('web.extra_devices_rate_title')), {
      target: { value: 'x' },
    });
    fireEvent.change(screen.getByLabelText(t('web.extra_packages_price')), {
      target: { value: '1000' },
    });
    for (const bad of ['0', '1.234', 'abc', '']) {
      fireEvent.change(screen.getByLabelText(t('web.extra_packages_amount_gb')), {
        target: { value: bad },
      });
      expect(save().disabled, `amount ${bad}`).toBe(true);
    }
    fireEvent.change(screen.getByLabelText(t('web.extra_packages_amount_gb')), {
      target: { value: '1' },
    });
    expect(save().disabled).toBe(false);
    fireEvent.change(screen.getByLabelText(t('web.extra_packages_price')), {
      target: { value: '0' },
    });
    expect(save().disabled).toBe(true);
    cleanup();
  });

  it('disables Save for a traffic amount past the server maximum', async () => {
    stubApi(routes());
    renderPage(page(null));
    await screen.findByText('ده گیگ');
    fireEvent.click(screen.getByRole('button', { name: t('web.cb_add') }));
    await screen.findByText(t('web.extra_packages_new'));
    const save = () => screen.getByText(t('web.extra_devices_save')) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText(t('web.extra_devices_rate_title')), {
      target: { value: 'x' },
    });
    fireEvent.change(screen.getByLabelText(t('web.extra_packages_price')), {
      target: { value: '1000' },
    });
    fireEvent.change(screen.getByLabelText(t('web.extra_packages_amount_gb')), {
      target: { value: '1024000' },
    });
    expect(save().disabled).toBe(false);
    fireEvent.change(screen.getByLabelText(t('web.extra_packages_amount_gb')), {
      target: { value: '1024001' },
    });
    expect(save().disabled).toBe(true);
    cleanup();
  });

  it('keeps the tab strip for a role that may edit but not view', () => {
    stubApi(routes());
    renderPage(
      <ExtraPackagesPage
        route={{ path: '/extra-devices', query: new URLSearchParams('') }}
        denied={true}
        mayEdit={true}
      />,
    );
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    cleanup();
  });

  it('draws no tab strip when the role may neither view nor edit', () => {
    stubApi(routes());
    renderPage(
      <ExtraPackagesPage
        route={{ path: '/extra-devices', query: new URLSearchParams('') }}
        denied={true}
        mayEdit={false}
      />,
    );
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    cleanup();
  });

  it('draws no write control for a role that may only view', async () => {
    stubApi(routes());
    const { container } = renderPage(page(null, false));
    await screen.findByText('ده گیگ');
    expect(screen.queryByRole('button', { name: t('web.cb_add') })).toBeNull();
    expect(container.textContent).not.toContain(t('web.extra_devices_edit'));
    cleanup();
  });

  it('parses amounts the way the server does', () => {
    expect(trafficAmountOf('10')).toBe('10');
    expect(trafficAmountOf(' 0.5 ')).toBe('0.5');
    expect(trafficAmountOf('0')).toBeNull();
    expect(trafficAmountOf('1.234')).toBeNull();
    // The ceiling is the contract's MAX_TRAFFIC_BYTES: 1,024,000 GB exactly, and not a hundredth more.
    expect(trafficAmountOf('1024000')).toBe('1024000');
    expect(trafficAmountOf('1024000.01')).toBeNull();
    expect(trafficAmountOf('999999999')).toBeNull();
    expect(daysAmountOf('30')).toBe(30);
    expect(daysAmountOf('0')).toBeNull();
    expect(daysAmountOf('3651')).toBeNull();
    expect(daysAmountOf('1.5')).toBeNull();
  });

  it('is routed at /extra-devices under the new name', () => {
    const route = { path: '/extra-devices', query: new URLSearchParams() };
    expect(resolve(route, ['catalog.view']).title).toBe(t('web.extra_packages_title'));
  });
});
