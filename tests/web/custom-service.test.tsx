import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { DISCOUNTABLE_PURPOSES, ORDER_PURPOSES, customServiceVolumeBytes } from '@nexa/contracts';
import { CustomServicePage } from '../../apps/web/src/pages/custom-service';
import { ORDER_PURPOSE_LABELS, OrderDetailPage } from '../../apps/web/src/pages/orders';
import { PURPOSE_LABELS } from '../../apps/web/src/pages/discounts';
import { registryLabel } from '../../apps/web/src/pages/settings';
import { NAV, navPermitted, resolve } from '../../apps/web/src/app';
import { t } from '../../apps/web/src/i18n/web.fa';
import { order, panel, renderPage, stubApi, type Api, type Route } from './harness';

/**
 * Package D on the Web Admin (`docs/package-d-custom-service-audit.md`): the locations a
 * customer may choose from, the price rules, and a custom order's frozen terms.
 *
 * Every response goes through the real client and the contract schemas, so a fixture that
 * drifts from `customServiceRuleSummarySchema` fails here rather than in production. What
 * these cases hold is what the screen DOES: render each rule's range in its own unit,
 * refuse a bound the server would refuse before sending it, name the overlap refusal in
 * Persian, post the body the contract declares, and show a custom order's snapshot.
 */

const PANEL_ID = panel().id as string;
const TIER_ID = '019290ab-cdef-7012-8345-6789abcdef01';
const CUSTOMER_ID = '019210ab-cdef-7012-8345-6789abcdef01';
const VOLUME_RULE_ID = '0192a0ab-cdef-7012-8345-6789abcdef01';
const TIME_RULE_ID = '0192a0ab-cdef-7012-8345-6789abcdef02';
const ORDER_ID = '019230ab-cdef-7012-8345-6789abcdef01';

function rule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: VOLUME_RULE_ID,
    dimension: 'VOLUME',
    label: 'Bulk volume',
    minimum: '10.25',
    maximum: '1000.5',
    unitPriceAmount: '2000',
    currency: 'IRT',
    customerId: null,
    resellerTierId: null,
    panelId: PANEL_ID,
    enabled: true,
    createdAt: '2026-09-01T08:00:00.000Z',
    updatedAt: '2026-09-02T08:00:00.000Z',
    ...overrides,
  };
}

const timeRule = () =>
  rule({
    id: TIME_RULE_ID,
    dimension: 'TIME',
    label: 'Monthly days',
    minimum: '1',
    maximum: '30',
    unitPriceAmount: '500',
    resellerTierId: TIER_ID,
    panelId: null,
    enabled: false,
  });

function location(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    panelId: PANEL_ID,
    panelName: 'Frankfurt A',
    label: '🇩🇪 آلمان',
    enabled: true,
    createdAt: '2026-09-01T08:00:00.000Z',
    updatedAt: '2026-09-02T08:00:00.000Z',
    ...overrides,
  };
}

const tier = {
  id: TIER_ID,
  name: 'Gold',
  pricingMode: 'PERCENTAGE_DISCOUNT',
  discountPercentage: 20,
  creditLimit: { amount: '100000', currency: 'IRT' },
  grants: [],
  resellerCount: 1,
  createdAt: '2026-09-01T08:00:00.000Z',
  updatedAt: '2026-09-01T08:00:00.000Z',
};

/**
 * The page's reads. The rule list and the create share a PATH and the harness routes by
 * URL alone, so one body answers both — each schema strips the other's key.
 */
const routes = (
  options: {
    rules?: readonly Record<string, unknown>[];
    locations?: readonly Record<string, unknown>[];
    extra?: readonly Route[];
  } = {},
): Route[] => [
  {
    url: '/custom-service/rules',
    body: { rules: options.rules ?? [rule(), timeRule()], rule: rule() },
  },
  {
    url: '/custom-service/locations',
    body: { locations: options.locations ?? [], location: location() },
  },
  { url: '/panels', body: { panels: [panel()], nextCursor: null } },
  { url: '/reseller-tiers', body: { tiers: [tier] } },
  ...(options.extra ?? []),
];

function render(mayEdit = true) {
  return renderPage(
    <CustomServicePage denied={false} mayEdit={mayEdit} mayViewPanels mayViewTiers />,
  );
}

function input(id: string): HTMLInputElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`no element #${id}`);
  return found as HTMLInputElement;
}

function posts(api: Api, fragment: string) {
  return api.calls.filter((call) => call.method === 'POST' && call.url.endsWith(fragment));
}

function rowOf(text: string): HTMLElement {
  const row = screen.getByText(text).closest('tr');
  if (row === null) throw new Error(`no row for ${text}`);
  return row;
}

describe('the price rules table', () => {
  it('renders a VOLUME rule in GB and a TIME rule in days, each with its own price unit', async () => {
    stubApi(routes());
    render();
    await screen.findByText('Bulk volume');

    const volume = rowOf('Bulk volume');
    // The bounds as typed, the whole part grouped, and the unit is GB.
    expect(within(volume).getByText('10.25')).toBeInTheDocument();
    expect(within(volume).getByText('1,000.5')).toBeInTheDocument();
    expect(volume.textContent).toContain('گیگابایت');
    expect(volume.textContent).toContain('2,000');
    expect(volume.textContent).toContain('برای هر گیگابایت');
    expect(volume.textContent).toContain('مشتریان عادی');
    // The panel by its operator name, from the fleet list.
    expect(volume.textContent).toContain('Frankfurt A');
    expect(volume.textContent).toContain('روشن');

    const time = rowOf('Monthly days');
    expect(within(time).getByText('1')).toBeInTheDocument();
    expect(within(time).getByText('30')).toBeInTheDocument();
    expect(time.textContent).toContain('روز');
    expect(time.textContent).not.toContain('گیگابایت');
    expect(time.textContent).toContain('برای هر روز');
    // A tier rule names the tier, by its name.
    expect(time.textContent).toContain('سطح نمایندگی');
    expect(time.textContent).toContain('Gold');
    expect(time.textContent).toContain('همهٔ پنل‌ها');
    expect(time.textContent).toContain('خاموش');
  });

  it('names a customer rule by a link to the customer', async () => {
    stubApi(routes({ rules: [rule({ customerId: CUSTOMER_ID, label: 'VIP' })] }));
    render();
    await screen.findByText('VIP');
    const link = within(rowOf('VIP')).getByRole('link');
    expect(link.getAttribute('href')).toBe(`/users/${CUSTOMER_ID}`);
  });

  it('states the specificity order and that the flag must be on', async () => {
    stubApi(routes());
    render();
    await screen.findByText('Bulk volume');
    const levels = screen.getAllByRole('listitem').map((item) => item.textContent);
    expect(levels).toEqual([
      t('web.custom_service_level_customer_panel'),
      t('web.custom_service_level_customer_all_panels'),
      t('web.custom_service_level_tier_panel'),
      t('web.custom_service_level_tier_all_panels'),
    ]);
    expect(screen.getByText(/custom_service/)).toBeInTheDocument();
  });
});

describe('writing a price rule', () => {
  const fill = (minimum: string, maximum: string, price: string) => {
    fireEvent.change(input('custom-rule-create-minimum'), { target: { value: minimum } });
    fireEvent.change(input('custom-rule-create-maximum'), { target: { value: maximum } });
    fireEvent.change(input('custom-rule-create-price'), { target: { value: price } });
  };

  it('refuses a GB bound with three decimals before sending, and sends the contract body once fixed', async () => {
    const api = stubApi(routes());
    render();
    await screen.findByText('Bulk volume');

    fill('10.255', '20', '1500');
    const create = screen.getByRole('button', { name: t('web.custom_service_rule_create') });
    expect(screen.getByText(t('web.custom_service_problem_volume_bound'))).toBeInTheDocument();
    expect(create).toBeDisabled();
    fireEvent.click(create);
    expect(posts(api, '/custom-service/rules')).toHaveLength(0);

    fill('10.25', '20', '1500');
    fireEvent.change(input('custom-rule-create-label'), { target: { value: 'Starter' } });
    fireEvent.change(input('custom-rule-create-audience'), { target: { value: 'TIER' } });
    fireEvent.change(input('custom-rule-create-tier'), { target: { value: TIER_ID } });
    fireEvent.change(input('custom-rule-create-panel'), { target: { value: PANEL_ID } });
    expect(screen.queryByText(t('web.custom_service_problem_volume_bound'))).toBeNull();
    fireEvent.click(create);

    await waitFor(() => expect(posts(api, '/custom-service/rules')).toHaveLength(1));
    expect(posts(api, '/custom-service/rules')[0]?.body).toEqual({
      dimension: 'VOLUME',
      label: 'Starter',
      minimum: '10.25',
      maximum: '20',
      unitPriceAmount: '1500',
      customerId: null,
      resellerTierId: TIER_ID,
      panelId: PANEL_ID,
      enabled: true,
      idempotencyKey: expect.any(String),
    });
  });

  it('holds a TIME rule to whole days up to the ceiling', async () => {
    const api = stubApi(routes());
    render();
    await screen.findByText('Bulk volume');
    fireEvent.change(input('custom-rule-create-dimension'), { target: { value: 'TIME' } });

    for (const bad of ['1.5', '0', '3651']) {
      fill(bad, '30', '500');
      expect(screen.getByText(t('web.custom_service_problem_days_bound'))).toBeInTheDocument();
    }
    fill('31', '30', '500');
    expect(screen.getByText(t('web.custom_service_problem_range'))).toBeInTheDocument();
    fill('1', '3650', '0');
    expect(screen.getByText(t('web.custom_service_problem_price'))).toBeInTheDocument();
    expect(posts(api, '/custom-service/rules')).toHaveLength(0);
  });

  it('names the overlap refusal in Persian', async () => {
    stubApi(
      routes({
        extra: [
          {
            url: `/custom-service/rules/${VOLUME_RULE_ID}`,
            status: 409,
            body: {
              error: {
                kind: 'CONFLICT',
                code: 'commerce.custom_service_rule_overlap',
                message: 'This range overlaps an enabled rule.',
                details: { otherRuleId: TIME_RULE_ID },
                correlationId: 'test',
              },
            },
          },
        ],
      }),
    );
    render();
    await screen.findByText('Bulk volume');
    fireEvent.click(within(rowOf('Bulk volume')).getByRole('button', { name: 'ویرایش' }));
    expect(input('custom-rule-edit-minimum').value).toBe('10.25');
    const card = input('custom-rule-edit-minimum').closest('section') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: t('web.rule_save') }));
    expect(
      await within(card).findByText(t('web.custom_service_error_overlap')),
    ).toBeInTheDocument();
  });

  it('deletes a rule through its own route, with a key, only once confirmed', async () => {
    const api = stubApi(
      routes({
        extra: [{ url: `/custom-service/rules/${VOLUME_RULE_ID}/delete`, body: { deleted: true } }],
      }),
    );
    render();
    await screen.findByText('Bulk volume');
    const remove = within(rowOf('Bulk volume')).getByRole('button', { name: 'حذف' });

    window.confirm = () => false;
    fireEvent.click(remove);
    expect(posts(api, '/delete')).toHaveLength(0);

    window.confirm = () => true;
    fireEvent.click(remove);
    await waitFor(() =>
      expect(posts(api, `/custom-service/rules/${VOLUME_RULE_ID}/delete`)).toHaveLength(1),
    );
    expect(posts(api, '/delete')[0]?.body).toEqual({ idempotencyKey: expect.any(String) });
  });

  it('draws no write control without catalog.pricing.edit, and names the key', async () => {
    stubApi(routes({ locations: [location()] }));
    render(false);
    await screen.findByText('Bulk volume');
    expect(document.getElementById('custom-rule-create-minimum')).toBeNull();
    expect(document.getElementById('custom-location-label')).toBeNull();
    expect(screen.queryByRole('button', { name: 'ویرایش' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'حذف' })).toBeNull();
    expect(screen.getAllByText(/catalog\.pricing\.edit/).length).toBeGreaterThan(0);
  });
});

describe('locations', () => {
  it('lists every panel, and says whether it is offered', async () => {
    stubApi(
      routes({
        locations: [
          location(),
          // A panel the fleet list did not return still shows, by its location's name.
          location({
            panelId: '01a05e35-c9ad-7e93-bef3-1ed9b55292d0',
            panelName: 'Old Amsterdam',
            label: '🇳🇱 هلند',
            enabled: false,
          }),
        ],
      }),
    );
    render();
    await screen.findByText('🇩🇪 آلمان');
    expect(rowOf('🇩🇪 آلمان').textContent).toContain('Frankfurt A');
    expect(rowOf('🇩🇪 آلمان').textContent).toContain(t('web.custom_service_location_offered'));
    expect(rowOf('🇳🇱 هلند').textContent).toContain('Old Amsterdam');
    expect(rowOf('🇳🇱 هلند').textContent).toContain(t('web.custom_service_location_disabled'));
  });

  it('saves a location for a panel with the body the contract declares', async () => {
    const api = stubApi(routes());
    render();
    const offer = await screen.findByRole('button', {
      name: t('web.custom_service_location_offer'),
    });
    expect(offer.closest('tr')?.textContent).toContain('Frankfurt A');
    expect(offer.closest('tr')?.textContent).toContain(
      t('web.custom_service_location_not_offered'),
    );
    fireEvent.click(offer);

    fireEvent.change(input('custom-location-label'), { target: { value: '  🇩🇪 آلمان ' } });
    const card = input('custom-location-label').closest('section') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: t('web.rule_save') }));

    await waitFor(() =>
      expect(posts(api, `/custom-service/locations/${PANEL_ID}`)).toHaveLength(1),
    );
    expect(posts(api, `/custom-service/locations/${PANEL_ID}`)[0]?.body).toEqual({
      label: '🇩🇪 آلمان',
      enabled: true,
      idempotencyKey: expect.any(String),
    });
  });

  it('sends the switch state, and refuses an empty label before sending', async () => {
    const api = stubApi(routes({ locations: [location()] }));
    render();
    await screen.findByText('🇩🇪 آلمان');
    fireEvent.click(within(rowOf('🇩🇪 آلمان')).getByRole('button', { name: 'ویرایش' }));
    expect(input('custom-location-label').value).toBe('🇩🇪 آلمان');

    const card = input('custom-location-label').closest('section') as HTMLElement;
    fireEvent.change(input('custom-location-label'), { target: { value: ' ' } });
    expect(within(card).getByRole('button', { name: t('web.rule_save') })).toBeDisabled();
    expect(
      within(card).getByText(t('web.custom_service_problem_location_label')),
    ).toBeInTheDocument();

    fireEvent.change(input('custom-location-label'), { target: { value: '🇩🇪 آلمان' } });
    fireEvent.click(within(card).getByRole('switch'));
    fireEvent.click(within(card).getByRole('button', { name: t('web.rule_save') }));
    await waitFor(() =>
      expect(posts(api, `/custom-service/locations/${PANEL_ID}`)).toHaveLength(1),
    );
    expect(posts(api, `/custom-service/locations/${PANEL_ID}`)[0]?.body).toEqual({
      label: '🇩🇪 آلمان',
      enabled: false,
      idempotencyKey: expect.any(String),
    });
  });

  it('withdraws a location through its delete route', async () => {
    const api = stubApi(
      routes({
        locations: [location()],
        extra: [{ url: `/custom-service/locations/${PANEL_ID}/delete`, body: { deleted: true } }],
      }),
    );
    window.confirm = () => true;
    render();
    await screen.findByText('🇩🇪 آلمان');
    fireEvent.click(within(rowOf('🇩🇪 آلمان')).getByRole('button', { name: 'حذف' }));
    await waitFor(() =>
      expect(posts(api, `/custom-service/locations/${PANEL_ID}/delete`)).toHaveLength(1),
    );
  });
});

describe("a custom order's terms", () => {
  const terms = {
    panelId: PANEL_ID,
    locationLabel: '🇩🇪 آلمان',
    volume: '10.25',
    trafficBytes: customServiceVolumeBytes(1025n).toString(),
    durationDays: 30,
    volumeRuleId: VOLUME_RULE_ID,
    volumeRuleLevel: 'CUSTOMER_PANEL',
    pricePerGbAmount: '2000',
    volumeAmount: '20500',
    timeRuleId: TIME_RULE_ID,
    timeRuleLevel: 'TIER_ALL_PANELS',
    pricePerDayAmount: '500',
    timeAmount: '15000',
    baseAmount: '35500',
    currency: 'IRT',
  };

  const detail = (overrides: Record<string, unknown>) => {
    const api = stubApi([
      { url: `/orders/${ORDER_ID}`, body: { order: order({ state: 'PAID', ...overrides }) } },
      { url: `/orders/${ORDER_ID}/custom-service`, body: { terms } },
      {
        url: `/orders/${ORDER_ID}/pricing`,
        body: {
          orderId: ORDER_ID,
          discountCode: null,
          subtotalAmount: '35500',
          discountAmount: '0',
          totalAmount: '35500',
          currency: 'IRT',
          adjustments: [],
          redemptions: [],
          cashback: null,
          reseller: null,
        },
      },
    ]);
    renderPage(
      <OrderDetailPage
        id={ORDER_ID}
        denied={false}
        mayViewPayments={false}
        mayViewServices={false}
      />,
    );
    return api;
  };

  it('shows the frozen terms of a CUSTOM_SERVICE order, and no product link', async () => {
    detail({ purpose: 'CUSTOM_SERVICE', productId: null, lineTitle: '🇩🇪 آلمان' });
    const title = await screen.findByText(t('web.order_custom_service_title'));
    const card = title.closest('section') as HTMLElement;
    await within(card).findByText(t('web.custom_service_level_customer_panel'), { exact: false });

    const text = card.textContent ?? '';
    expect(text).toContain('🇩🇪 آلمان');
    expect(text).toContain('10.25');
    expect(text).toContain('گیگابایت');
    expect(text).toContain('30');
    for (const figure of ['2,000', '500', '20,500', '15,000', '35,500']) {
      expect(text).toContain(figure);
    }
    expect(text).toContain(t('web.custom_service_level_tier_all_panels'));
    expect(text).toContain(VOLUME_RULE_ID);

    // No product to link to: the purpose says why instead.
    expect(document.querySelector('a[href^="/products/"]')).toBeNull();
    expect(screen.getAllByText('سرویس دلخواه').length).toBeGreaterThan(0);
  });

  it('asks for no custom terms for an ordinary purchase', async () => {
    const api = detail({});
    await screen.findByText(t('web.order_line_title'));
    await waitFor(() => expect(api.calls.some((call) => call.url.includes('/pricing'))).toBe(true));
    expect(api.calls.some((call) => call.url.includes('/custom-service'))).toBe(false);
    expect(document.querySelector('a[href^="/products/"]')).not.toBeNull();
  });
});

describe('the purpose and flag vocabularies', () => {
  it('names every order purpose, CUSTOM_SERVICE included', () => {
    for (const purpose of ORDER_PURPOSES) {
      expect(t(ORDER_PURPOSE_LABELS[purpose])).not.toBe('');
    }
    expect(t(ORDER_PURPOSE_LABELS.CUSTOM_SERVICE)).toBe('سرویس دلخواه');
  });

  it('names every discountable purpose, CUSTOM_SERVICE included', () => {
    expect(DISCOUNTABLE_PURPOSES).toContain('CUSTOM_SERVICE');
    for (const purpose of DISCOUNTABLE_PURPOSES) {
      expect(t(PURPOSE_LABELS[purpose])).not.toBe('');
    }
    expect(t(PURPOSE_LABELS.CUSTOM_SERVICE)).toBe('سرویس دلخواه');
  });

  it('names the custom_service flag on the settings screens', () => {
    expect(registryLabel('custom_service')).toBe('سرویس دلخواه');
  });
});

describe('the /custom-service route', () => {
  it('offers the link on catalog.view, and not on a write key alone', () => {
    const entry = NAV.find((candidate) => candidate.id === 'custom-service');
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(entry.path).toBe('/custom-service');
    expect(navPermitted(entry, ['catalog.view'])).toBe(true);
    expect(navPermitted(entry, ['catalog.pricing.edit'])).toBe(false);
    expect(navPermitted(entry, [])).toBe(false);
  });

  it('resolves the real page, with write controls only on catalog.pricing.edit', async () => {
    stubApi(routes());
    const resolved = resolve({ path: '/custom-service', query: new URLSearchParams() }, [
      'catalog.view',
    ]);
    renderPage(resolved.element as ReactElement);
    await screen.findByText('Bulk volume');
    expect(document.getElementById('custom-rule-create-minimum')).toBeNull();
  });

  it('asks the server nothing without catalog.view', () => {
    const api = stubApi(routes());
    renderPage(<CustomServicePage denied mayEdit={false} mayViewPanels mayViewTiers />);
    expect(api.calls).toHaveLength(0);
  });
});
