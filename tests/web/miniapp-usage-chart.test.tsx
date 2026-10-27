import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MINIAPP_FA } from '../../apps/miniapp/src/i18n/miniapp.fa';
import { MiniAppApi } from '../../apps/miniapp/src/api';
import { traffic } from '../../apps/miniapp/src/format';
import { ServiceDetail } from '../../apps/miniapp/src/screens/service-detail';
import { UsageChart, plot } from '../../apps/miniapp/src/screens/usage-chart';

/**
 * R11 B2: the usage chart on the mini app's service screen.
 *
 * Rendered against a REAL `MiniAppApi` over a stubbed `fetch`, so the route, the query and the
 * contract schema are the production path. Shown: the points as a line, the 7/30 day toggle
 * asking the server for the other range, an empty range saying so, a failed read with a retry,
 * and, when the server says the feature is off, NO chart and NO request for one. Never drawn:
 * a connected-device count.
 */

const state = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock('../../apps/miniapp/src/app', () => ({ useApp: () => state.ctx }));

const BOT = '01900000-0000-7000-8000-00000000a001';
const fa = (key: keyof typeof MINIAPP_FA) => MINIAPP_FA[key];
const GIB = 1024n ** 3n;

let urls: string[] = [];
let usageAnswer: (days: string) => { status?: number; body: unknown };
let detail: Record<string, unknown>;

const history = (days: number, points: [string, bigint][]) => ({
  days,
  from: new Date(Date.parse('2026-10-26T00:00:00Z') - days * 86_400_000).toISOString(),
  to: '2026-10-26T00:00:00.000Z',
  points: points.map(([at, used]) => ({ at, usedBytes: used.toString() })),
  totalBytes: String(50n * GIB),
  expiresAt: null,
});

const service = (overrides: Record<string, unknown> = {}) => ({
  id: 's1',
  code: 'S1',
  title: 'پلن پایه',
  state: 'ACTIVE',
  username: 'nx1',
  trafficUsedBytes: String(GIB),
  trafficLimitBytes: String(50n * GIB),
  expiresAt: '2026-12-20T00:00:00.000Z',
  usageSyncedAt: '2026-10-25T00:00:00.000Z',
  deviceLimit: 3,
  locationLabel: 'آلمان',
  isTrial: false,
  subscriptionUrl: null,
  working: false,
  actions: [],
  qr: false,
  canChangeLocation: false,
  autoRenew: { offered: false, enabled: false, price: null, leadHours: 24 },
  usageChart: true,
  ...overrides,
});

beforeEach(() => {
  urls = [];
  detail = service();
  usageAnswer = (days) => ({
    body: history(Number(days), [
      ['2026-10-23T08:00:00.000Z', GIB],
      ['2026-10-24T08:00:00.000Z', 3n * GIB],
      ['2026-10-25T08:00:00.000Z', 6n * GIB],
    ]),
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url);
      const [path, query = ''] = url.replace('/miniapp/api/v1', '').split('?');
      if (path === '/services/s1') return new Response(JSON.stringify(detail), { status: 200 });
      if (path === '/services/s1/usage') {
        const answer = usageAnswer(new URLSearchParams(query).get('days') ?? '7');
        return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
      }
      return new Response('{}', { status: 404 });
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

const usageUrls = () => urls.filter((url) => url.includes('/usage'));

describe('the usage chart', () => {
  it('draws the stored points as a line over the last 7 days', async () => {
    render(<UsageChart serviceId="s1" />);
    const chart = await screen.findByTestId('usage-chart');
    expect(usageUrls()).toEqual(['/miniapp/api/v1/services/s1/usage?days=7']);
    expect(chart.querySelector('polyline')).not.toBeNull();
    expect(chart.querySelectorAll('circle')).toHaveLength(3);
    expect(chart.getAttribute('role')).toBe('img');
    expect(chart.getAttribute('aria-label')).toContain(' 7 ');
    expect(screen.getByText(fa('miniapp.usage_title'))).toBeTruthy();
    // The scale is the largest stored figure; the newest figure is named.
    expect(screen.getByText(`بیشترین مصرف ثبت‌شده در این بازه: ${traffic(6n * GIB)}`)).toBeTruthy();
  });

  it('asks the server for 30 days when the toggle moves, and back', async () => {
    render(<UsageChart serviceId="s1" />);
    await screen.findByTestId('usage-chart');
    const seven = screen.getByText(fa('miniapp.usage_range_7'));
    const thirty = screen.getByText(fa('miniapp.usage_range_30'));
    expect(seven.getAttribute('aria-pressed')).toBe('true');
    expect(thirty.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(thirty);
    await waitFor(() => expect(usageUrls()).toContain('/miniapp/api/v1/services/s1/usage?days=30'));
    await waitFor(() =>
      expect(screen.getByText(fa('miniapp.usage_range_30')).getAttribute('aria-pressed')).toBe(
        'true',
      ),
    );
    expect((await screen.findByTestId('usage-chart')).getAttribute('aria-label')).toContain(' 30 ');
    fireEvent.click(screen.getByText(fa('miniapp.usage_range_7')));
    await waitFor(() =>
      expect(usageUrls().filter((url) => url.endsWith('days=7'))).toHaveLength(2),
    );
  });

  it('says so when the range holds no figure, and draws no line', async () => {
    usageAnswer = (days) => ({ body: history(Number(days), []) });
    render(<UsageChart serviceId="s1" />);
    expect(await screen.findByText(fa('miniapp.usage_empty'))).toBeTruthy();
    expect(screen.queryByTestId('usage-chart')).toBeNull();
  });

  it('draws a single point as a dot, not a line', async () => {
    usageAnswer = (days) => ({ body: history(Number(days), [['2026-10-25T08:00:00.000Z', GIB]]) });
    render(<UsageChart serviceId="s1" />);
    const chart = await screen.findByTestId('usage-chart');
    expect(chart.querySelector('polyline')).toBeNull();
    expect(chart.querySelectorAll('circle')).toHaveLength(1);
  });

  it('shows the server’s refusal with a retry that asks again', async () => {
    usageAnswer = () => ({
      status: 409,
      body: { error: { kind: 'CONFLICT', code: 'miniapp.session_expired' } },
    });
    render(<UsageChart serviceId="s1" />);
    const retry = await screen.findByText(fa('miniapp.retry'));
    usageAnswer = (days) => ({ body: history(Number(days), [['2026-10-25T08:00:00.000Z', GIB]]) });
    fireEvent.click(retry);
    expect(await screen.findByTestId('usage-chart')).toBeTruthy();
    expect(usageUrls()).toHaveLength(2);
  });

  it('maps a figure onto the plot in bigint thousandths: the largest touches the top', () => {
    const { points, max } = plot(
      history(7, [
        ['2026-10-20T00:00:00.000Z', 0n],
        ['2026-10-23T00:00:00.000Z', 5n * GIB],
        ['2026-10-25T00:00:00.000Z', 10n * GIB],
      ]),
    );
    expect(max).toBe(10n * GIB);
    const ys = points.map((point) => point.y);
    expect(ys[0]).toBeGreaterThan(ys[1] as number);
    expect(ys[1]).toBeGreaterThan(ys[2] as number);
    expect(ys[2]).toBe(10);
    expect(points.map((point) => point.x)).toEqual(
      [...points.map((point) => point.x)].sort((a, b) => a - b),
    );
  });
});

describe('the chart on the service screen', () => {
  it('is drawn when the server says the feature is on', async () => {
    render(<ServiceDetail serviceId="s1" />);
    expect(await screen.findByTestId('usage-chart')).toBeTruthy();
    expect(usageUrls()).toHaveLength(1);
  });

  it('is neither drawn nor requested when the feature is off', async () => {
    detail = service({ usageChart: false });
    render(<ServiceDetail serviceId="s1" />);
    await screen.findByText('پلن پایه');
    expect(screen.queryByText(fa('miniapp.usage_title'))).toBeNull();
    expect(screen.queryByTestId('usage-chart')).toBeNull();
    expect(usageUrls(), 'no request for a chart that is off').toEqual([]);
  });

  it('shows no connected-device count anywhere in the chart', async () => {
    render(<UsageChart serviceId="s1" />);
    const chart = await screen.findByTestId('usage-chart');
    const text = `${chart.parentElement?.textContent ?? ''}${chart.getAttribute('aria-label') ?? ''}`;
    expect(text).not.toMatch(/دستگاه/u);
  });
});
