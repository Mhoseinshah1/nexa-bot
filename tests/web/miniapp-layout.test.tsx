import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MiniAppApi } from '../../apps/miniapp/src/api';
import { MINIAPP_FA } from '../../apps/miniapp/src/i18n/miniapp.fa';
import { Checkout } from '../../apps/miniapp/src/screens/checkout';
import { Store } from '../../apps/miniapp/src/screens/store';

/**
 * v0.9.5 PR-5 — the mini app's layout: a shop card with ONE tap target (the real button, no
 * nested interactive element), and the username-rule list outside every row flex container.
 */

const state = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock('../../apps/miniapp/src/app', () => ({ useApp: () => state.ctx }));

const BOT = '01900000-0000-7000-8000-00000000a001';
const wire = (amount: string) => ({ amountMinor: amount, currency: 'IRT' });
let routes: Record<string, () => unknown> = {};

beforeEach(() => {
  routes = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = (url.replace('/miniapp/api/v1', '').split('?')[0] ?? '').toString();
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
  sessionStorage.clear();
});

const css = readFileSync(resolve(__dirname, '../../apps/miniapp/src/styles/base.css'), 'utf8');
const rule = (selector: string) =>
  new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`, 'u').exec(css)?.[1] ?? '';

describe('shop cards', () => {
  it('a plan card has exactly one tap target, and the title and price share one head row', async () => {
    routes['GET /catalogue/categories'] = () => ({
      items: [{ id: 'c1', name: 'ماهانه', emoji: null }],
      page: 0,
      hasMore: false,
    });
    routes['GET /catalogue/categories/c1'] = () => ({
      items: [
        {
          id: '01900000-0000-7000-8000-0000000000a1',
          title: 'پلن اول',
          price: wire('100000'),
          personalDiscount: null,
          trafficBytes: String(50n * 1024n ** 3n),
          durationDays: 30,
          deviceLimit: null,
          locations: [],
          features: ['ویژگی'],
        },
      ],
      page: 0,
      hasMore: false,
    });
    render(<Store />);
    const title = await screen.findByText('پلن اول');
    const card = title.closest('section.plan') as HTMLElement;
    expect(within(card).getAllByRole('button')).toHaveLength(1);
    expect(card.querySelector('button button, a button, button a')).toBeNull();
    expect(
      within(card).getByRole('button', { name: MINIAPP_FA['miniapp.store_continue'] }),
    ).toBeTruthy();
    expect(title.parentElement?.className).toBe('card-head');
    expect(card.querySelector('.card-head .price')).not.toBeNull();
    // Volume and days share one muted line.
    expect(card.querySelector('.plan-figures.muted')?.children).toHaveLength(2);
  });
});

describe('the username rule list', () => {
  it('is a child of a column form, never a flex-row item', async () => {
    const id = '01900000-0000-7000-8000-0000000000c1';
    routes[`GET /orders/${id}`] = () => ({
      id,
      code: 'ABCD1234',
      state: 'DRAFT',
      purpose: 'NEW_SERVICE',
      title: 'پلن پایه',
      trafficBytes: String(50n * 1024n ** 3n),
      durationDays: 30,
      subtotal: wire('250000'),
      discount: wire('0'),
      total: wire('250000'),
      discountApplied: false,
      personalDiscountPercent: null,
      discountEditable: true,
      cashback: null,
      expiresAt: null,
      serviceId: null,
      username: null,
      usernameModes: ['AUTOMATIC', 'CUSTOM'],
      locations: [],
      features: [],
      description: null,
    });
    routes[`GET /orders/${id}/payment-routes`] = () => ({
      wallet: { balance: wire('0'), sufficient: false, shortfall: wire('250000') },
      routes: [],
    });
    render(<Checkout orderId={id} />);
    const list = await screen.findByTestId('username-rule');
    const form = list.closest('form') as HTMLElement;
    expect(form.classList.contains('stack-form')).toBe(true);
    expect(rule('.stack-form')).toMatch(/flex-direction:\s*column/u);
    expect(rule('.inline-form')).toMatch(/display:\s*flex/u);
  });

  it('no list is ever a direct child of an .inline-form in any mini app screen', () => {
    const dir = resolve(__dirname, '../../apps/miniapp/src/screens');
    const offenders: string[] = [];
    for (const name of ['checkout', 'wallet', 'store', 'referral', 'support', 'trial']) {
      const text = readFileSync(`${dir}/${name}.tsx`, 'utf8');
      for (const form of text.matchAll(
        /<form\s+className="inline-form"[^>]*>([\s\S]*?)<\/form>/gu,
      )) {
        if (/<(ul|ol)\b/u.test(form[1] ?? '')) offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });
});
