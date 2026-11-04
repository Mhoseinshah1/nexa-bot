import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MiniAppApi } from '../../apps/miniapp/src/api';
import { MINIAPP_FA } from '../../apps/miniapp/src/i18n/miniapp.fa';
import { Store } from '../../apps/miniapp/src/screens/store';

/**
 * V099: the store is step by step — (server →) category → plan — over a REAL `MiniAppApi`
 * and a stubbed `fetch`. `serverId` rides on the category and plan calls only when a server
 * was chosen, and changing the server resets the category.
 */

const state = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock('../../apps/miniapp/src/app', () => ({ useApp: () => state.ctx }));

const BOT = '01900000-0000-7000-8000-00000000a001';
const S1 = '01900000-0000-7000-8000-0000000000b1';
const S2 = '01900000-0000-7000-8000-0000000000b2';
const PLAN = '01900000-0000-7000-8000-0000000000a1';
const fa = (key: keyof typeof MINIAPP_FA) => MINIAPP_FA[key];

let routes: Record<string, (url: URL) => unknown> = {};
let calls: string[] = [];
let navigate: ReturnType<typeof vi.fn>;

const plan = (title: string) => ({
  id: PLAN,
  title,
  price: { amountMinor: '100000', currency: 'IRT' },
  personalDiscount: null,
  trafficBytes: String(50n * 1024n ** 3n),
  durationDays: 30,
  deviceLimit: null,
  locations: [],
  features: [],
});

beforeEach(() => {
  routes = {};
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const full = url.replace('/miniapp/api/v1', '');
      calls.push(`${method} ${full}`);
      const handler = routes[`${method} ${full.split('?')[0] ?? ''}`];
      if (handler === undefined) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(handler(new URL(full, 'http://x'))), { status: 200 });
    }),
  );
  navigate = vi.fn();
  state.ctx = { api: new MiniAppApi(BOT), navigate };
  routes['GET /catalogue/categories'] = (url) => ({
    items:
      url.searchParams.get('serverId') === S2
        ? [{ id: 'c9', name: 'سالانه', emoji: null }]
        : [{ id: 'c1', name: 'ماهانه', emoji: '🔥' }],
    page: 0,
    hasMore: false,
  });
  routes['GET /catalogue/categories/c1'] = () => ({
    items: [plan('پلن اول')],
    page: 0,
    hasMore: false,
  });
  routes['GET /catalogue/categories/c9'] = () => ({
    items: [plan('پلن سالانه')],
    page: 0,
    hasMore: false,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const back = () =>
  fireEvent.click(screen.getByRole('button', { name: fa('miniapp.store_step_back') }));
const servers = (step: boolean) => {
  routes['GET /catalogue/servers'] = () => ({
    enabled: true,
    step,
    items: step
      ? [
          { id: S1, name: 'سرور آلمان' },
          { id: S2, name: 'سرور ترکیه' },
        ]
      : [],
    page: 0,
    hasMore: false,
  });
};

describe('the store steps', () => {
  it('step false: no server step; categories, then plans, then back', async () => {
    servers(false);
    render(<Store />);
    fireEvent.click(await screen.findByRole('button', { name: '🔥 ماهانه' }));
    await screen.findByText('پلن اول');
    expect(screen.queryByText(fa('miniapp.store_step_server'))).toBeNull();
    expect(calls.some((call) => call.includes('serverId'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: fa('miniapp.store_continue') }));
    back();
    await screen.findByText(fa('miniapp.store_step_category'));
    expect(screen.queryByText('پلن اول')).toBeNull();
  });

  it('a plan still leads to the same order and checkout', async () => {
    servers(false);
    routes['POST /orders'] = () => ({ id: 'o1' });
    render(<Store />);
    fireEvent.click(await screen.findByRole('button', { name: '🔥 ماهانه' }));
    await screen.findByText('پلن اول');
    fireEvent.click(screen.getByRole('button', { name: fa('miniapp.store_continue') }));
    await waitFor(() => expect(calls).toContain('POST /orders'));
  });

  it('a failing servers read falls back to the categories', async () => {
    render(<Store />);
    await screen.findByRole('button', { name: '🔥 ماهانه' });
  });

  it('step true: servers, categories and plans carry serverId; a server change resets the category', async () => {
    servers(true);
    render(<Store />);
    await screen.findByText(fa('miniapp.store_step_server'));
    expect(screen.queryByRole('button', { name: fa('miniapp.store_step_back') })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'سرور آلمان' }));
    fireEvent.click(await screen.findByRole('button', { name: '🔥 ماهانه' }));
    await screen.findByText('پلن اول');
    expect(calls).toContain(`GET /catalogue/categories?page=0&serverId=${S1}`);
    expect(calls).toContain(`GET /catalogue/categories/c1?page=0&serverId=${S1}`);
    // Back to the categories, back to the servers; another server shows ITS categories.
    back();
    await screen.findByText(fa('miniapp.store_step_category'));
    back();
    fireEvent.click(await screen.findByRole('button', { name: 'سرور ترکیه' }));
    await screen.findByRole('button', { name: 'سالانه' });
    expect(screen.queryByRole('button', { name: '🔥 ماهانه' })).toBeNull();
    expect(calls).toContain(`GET /catalogue/categories?page=0&serverId=${S2}`);
    fireEvent.click(screen.getByRole('button', { name: 'سالانه' }));
    await screen.findByText('پلن سالانه');
    expect(calls).toContain(`GET /catalogue/categories/c9?page=0&serverId=${S2}`);
  });
});
