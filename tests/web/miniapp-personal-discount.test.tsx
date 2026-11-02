import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatMoney } from '@nexa/i18n';
import { money } from '@nexa/contracts';
import { MINIAPP_FA } from '../../apps/miniapp/src/i18n/miniapp.fa';
import { MiniAppApi } from '../../apps/miniapp/src/api';
import { Store } from '../../apps/miniapp/src/screens/store';
import { ServiceDetail } from '../../apps/miniapp/src/screens/service-detail';

/**
 * R11 A9: the mini app's price lists — the store and a service's renewal / package offer —
 * draw a line the customer's personal discount wins as the old price struck through, the
 * discounted price and «تخفیف شخصی N٪», all three from the server's figures (the server
 * holds the discounted one equal to the invoice: `tests/integration/r11-personal-discount-
 * listing.test.ts`). A line with no personal discount is drawn exactly as before: one price,
 * no strike, no tag. Rendered against a REAL `MiniAppApi` over a stubbed `fetch`, so the
 * contract schemas are the production path; only the shell (`useApp`) is replaced.
 */

const state = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock('../../apps/miniapp/src/app', () => ({ useApp: () => state.ctx }));

const BOT = '01900000-0000-7000-8000-00000000a001';
const wire = (amount: string) => ({ amountMinor: amount, currency: 'IRT' });
const shown = (amount: bigint) => formatMoney(money(amount, 'IRT'));
const TAG = MINIAPP_FA['miniapp.personal_discount_tag'].replace('{percent}', '20');

let routes: Record<string, () => unknown> = {};

beforeEach(() => {
  routes = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = url.replace('/miniapp/api/v1', '').split('?')[0] ?? '';
      const handler = routes[`${init.method ?? 'GET'} ${path}`];
      if (handler === undefined) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(handler()), { status: 200 });
    }),
  );
  state.ctx = {
    api: new MiniAppApi(BOT),
    me: {},
    refreshMe: vi.fn(async () => undefined),
    navigate: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

const plan = (id: string, title: string, personalDiscount: unknown) => ({
  id,
  title,
  price: wire('100000'),
  personalDiscount,
  trafficBytes: String(50n * 1024n ** 3n),
  durationDays: 30,
  deviceLimit: null,
  locations: [],
  features: [],
});

describe('R11 A9: the mini app lists the personal discount the invoice charges', () => {
  it('the store: old price struck, the discounted price and the tag; others unchanged', async () => {
    routes['GET /catalogue/categories'] = () => ({
      items: [{ id: 'c1', name: 'ماهانه', emoji: null }],
      page: 0,
      hasMore: false,
    });
    routes['GET /catalogue/categories/c1'] = () => ({
      items: [
        plan('01900000-0000-7000-8000-0000000000a1', 'پلن شخصی', {
          percent: 20,
          price: wire('80000'),
        }),
        plan('01900000-0000-7000-8000-0000000000a2', 'پلن عادی', null),
      ],
      page: 0,
      hasMore: false,
    });
    render(<Store />);
    const discounted = (await screen.findByText('پلن شخصی')).closest('section') as HTMLElement;
    const struck = discounted.querySelector('s.personal-price-was');
    expect(struck?.textContent).toBe(shown(100_000n));
    expect(discounted.querySelector('.personal-price-now')?.textContent).toBe(shown(80_000n));
    expect(discounted.querySelector('.personal-price-tag')?.textContent).toBe(TAG);

    const ordinary = screen.getByText('پلن عادی').closest('section') as HTMLElement;
    expect(ordinary.querySelector('.personal-price')).toBeNull();
    expect(ordinary.querySelector('s')).toBeNull();
    expect(ordinary.querySelector('strong.price')?.textContent).toBe(shown(100_000n));
  });

  it('a service offer: the renewal line with the personal discount, a package without', async () => {
    routes['GET /services/s1'] = () => ({
      id: 's1',
      code: 'S1',
      title: 'پلن پایه',
      state: 'ACTIVE',
      username: 'nx1',
      trafficUsedBytes: '0',
      trafficLimitBytes: String(50n * 1024n ** 3n),
      expiresAt: '2026-12-20T00:00:00.000Z',
      usageSyncedAt: null,
      deviceLimit: null,
      locationLabel: null,
      isTrial: false,
      subscriptionUrl: null,
      working: false,
      actions: ['RENEW'],
      qr: false,
      qrKinds: [],
      canChangeLocation: false,
      autoRenew: { offered: false, enabled: false, price: null, leadHours: 24 },
    });
    routes['GET /services/s1/offers/RENEW'] = () => ({
      kind: 'RENEW',
      options: [
        {
          addonId: null,
          planId: null,
          title: 'تمدید پلن پایه',
          price: wire('100000'),
          personalDiscount: { percent: 20, price: wire('80000') },
        },
        {
          addonId: '01900000-0000-7000-8000-0000000000b1',
          planId: null,
          title: 'سی روز',
          price: wire('50000'),
          personalDiscount: null,
        },
      ],
    });
    render(<ServiceDetail serviceId="s1" />);
    fireEvent.click(await screen.findByText(MINIAPP_FA['miniapp.service_action_RENEW']));
    const renewal = (await screen.findByText('تمدید پلن پایه')).closest('button') as HTMLElement;
    expect(renewal.querySelector('s.personal-price-was')?.textContent).toBe(shown(100_000n));
    expect(renewal.querySelector('.personal-price-now')?.textContent).toBe(shown(80_000n));
    expect(renewal.querySelector('.personal-price-tag')?.textContent).toBe(TAG);

    const time = screen.getByText('سی روز').closest('button') as HTMLElement;
    expect(time.querySelector('.personal-price')).toBeNull();
    expect(time.textContent).toBe(`سی روز${shown(50_000n)}`);
  });

  it('an older server that sends no personalDiscount reads as none', async () => {
    routes['GET /catalogue/categories'] = () => ({
      items: [{ id: 'c1', name: 'ماهانه', emoji: null }],
      page: 0,
      hasMore: false,
    });
    const legacy: Record<string, unknown> = plan(
      '01900000-0000-7000-8000-0000000000a3',
      'پلن قدیمی',
      null,
    );
    delete legacy['personalDiscount'];
    routes['GET /catalogue/categories/c1'] = () => ({ items: [legacy], page: 0, hasMore: false });
    render(<Store />);
    const line = (await screen.findByText('پلن قدیمی')).closest('section') as HTMLElement;
    expect(line.querySelector('.personal-price')).toBeNull();
    expect(line.querySelector('strong.price')?.textContent).toBe(shown(100_000n));
  });
});
