import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import type { PermissionKey } from '@nexa/contracts';
import { DashboardPage, periodHasNothing } from '../../apps/web/src/pages/dashboard';
import { DeltaPill } from '../../apps/web/src/pages/dashboard-parts';
import { AttentionQueueCard } from '../../apps/web/src/pages/dashboard-attention';
import { AreaSpark } from '../../apps/web/src/ui/charts';
import { kpiDelta } from '../../apps/web/src/dashboard-view';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';
import { DEMO_PARITY, DEMO_PARITY_EMPTY } from './shots/fixtures/demo-parity/index.ts';
import type { ShotFixture } from './shots/fixture.ts';

/**
 * The dashboard's composition against the approved demo (`docs/web-redesign/demo-parity`,
 * PROMPT.md §B). The bodies are the screenshot fixtures' own — `demo-parity` (the demo's
 * sample numbers) and `demo-parity-empty` — so the page tested here is the page the
 * side-by-sides photograph, and each body is already parsed by its response schema in
 * `shots-fixtures.test.tsx`.
 */

const OWNER: PermissionKey[] = [
  'reports.view',
  'panels.view',
  'services.view',
  'opslog.view',
  'payments.view',
  'tickets.view',
  'business_chats.view',
  'users.view',
];

/** The fixture set as `stubApi` routes (the harness matches by substring, longest first). */
function routesOf(set: readonly ShotFixture[]) {
  const seen = new Set<string>();
  return set
    .filter((fixture) => {
      if (seen.has(fixture.path)) return false;
      seen.add(fixture.path);
      return !fixture.path.includes(':');
    })
    .map((fixture) => ({ url: fixture.path, body: fixture.body }));
}

afterEach(() => {
  document.getElementById('main')?.remove();
});

describe('the dashboard header controls', () => {
  /*
   * v0.7.2: the owner's live dashboard showed no period control, no comparison switch and
   * no refresh. Not a data gate and not a permission — the shell keeps ONE scroller for
   * every page, so arriving from a page left half-way down opened the dashboard at that
   * offset, with its title row (and the controls on it) under the top bar.
   */
  it('renders all three with an empty shop, and the comparison is a switch', async () => {
    stubApi(routesOf(DEMO_PARITY_EMPTY));
    window.history.replaceState(null, '', '/');
    renderPage(<DashboardPage permissions={OWNER} superAdmin />);
    await screen.findByText(t('web.dashboard_methods_empty'));

    const period = screen.getByRole('group', { name: t('web.period_label') });
    for (const key of [
      'web.period_today',
      'web.period_7d',
      'web.period_30d',
      'web.period_month',
      'web.period_custom',
    ] as const) {
      expect(within(period).getByRole('button', { name: t(key) })).toBeInTheDocument();
    }
    expect(within(period).getByRole('button', { name: t('web.period_30d') })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const toggle = screen.getByRole('switch', { name: t('web.period_compare') });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: t('web.report_refresh') })).toBeInTheDocument();
  });

  it('opens at the top of the page whatever offset the shared scroller was left at', async () => {
    const main = document.createElement('main');
    main.id = 'main';
    document.body.append(main);
    main.scrollTop = 640;
    expect(main.scrollTop).toBe(640);
    stubApi(routesOf(DEMO_PARITY_EMPTY));
    renderPage(<DashboardPage permissions={[]} />);
    await waitFor(() => expect(main.scrollTop).toBe(0));
  });
});

describe('the dashboard composition', () => {
  it('draws the KPI block as hero, month card and a 2×2 of tiles, in the demo’s order', async () => {
    stubApi(routesOf(DEMO_PARITY));
    const { container } = renderPage(<DashboardPage permissions={OWNER} superAdmin />);
    await screen.findByText(t('web.dashboard_today_sales'));
    const grid = container.querySelector('.dash-kgrid') as HTMLElement;
    const hero = grid.querySelector(':scope > .kpi-hero') as HTMLElement;
    expect(hero.textContent).toContain(t('web.dashboard_today_sales'));
    expect(hero.textContent).toContain('13,623,019');
    expect(hero.querySelector('svg.area-spark.as-hero')).not.toBeNull();
    const month = grid.querySelector(':scope > .kpi-card') as HTMLElement;
    expect(month.textContent).toContain('220,882,810');
    const tiles = [...grid.querySelectorAll('.dash-mini > .kpi-tile')].map(
      (tile) => tile.querySelector('.dash-kpi-lbl')?.textContent,
    );
    expect(tiles).toEqual([
      t('web.dashboard_active_services'),
      t('web.dashboard_new_customers'),
      t('web.dashboard_renewals'),
      t('web.dashboard_failed_payments'),
    ]);
    // The second row: four equal cards, expiring first (the sidebar side).
    const ops = container.querySelector('.dash-ops') as HTMLElement;
    expect(ops.className).toContain('n4');
    expect(ops.children).toHaveLength(4);
    expect(ops.children[0]?.textContent).toContain(t('web.dashboard_expiring'));
    expect(ops.children[3]?.textContent).toContain(t('web.dashboard_period_sales'));
  });

  it('heads the operational row with its section label', async () => {
    stubApi(routesOf(DEMO_PARITY));
    const { container } = renderPage(<DashboardPage permissions={OWNER} superAdmin />);
    await screen.findByText('Marzban');
    await screen.findByText(t('web.readiness_dep_postgres'));
    const label = container.querySelector('.dash-sec') as HTMLElement;
    expect(label.textContent).toBe(t('web.dashboard_operations'));
    const row = label.nextElementSibling as HTMLElement;
    expect(row.textContent).toContain(t('web.dashboard_panel_distribution'));
    expect(row.textContent).toContain(t('web.system_status'));
    // One segmented bar per group (health, provider), every segment a geometry attribute.
    expect(row.querySelectorAll('svg.dash-stack')).toHaveLength(2);
    // The system card: a service card per dependency, its state a pill.
    expect(row.querySelectorAll('.dash-services > li')).toHaveLength(4);
    expect(row.querySelectorAll('.dash-services .badge')).toHaveLength(4);
  });

  /*
   * The demo's empty dashboard: when the SERVER's period figures are all zero, the period
   * blocks give way to one large card; the queue above and the operational section below
   * stay, because they are not period data.
   */
  it('replaces the period blocks with ONE empty card when the server recorded nothing', async () => {
    stubApi(routesOf(DEMO_PARITY_EMPTY));
    const { container } = renderPage(<DashboardPage permissions={OWNER} superAdmin />);
    const card = await waitFor(() => {
      const found = container.querySelector('.dash-empty-period');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(card.textContent).toContain(t('web.chart_empty'));
    expect(card.textContent).toContain(t('web.dashboard_methods_empty'));
    expect(container.querySelectorAll('.dash-empty-period')).toHaveLength(1);
    // No KPI tile (no dash or zero tiles), no second row, no charts, no period cards.
    for (const selector of ['.dash-kgrid', '.dash-kpi', '.dash-ops', '.dash-charts', '.dash-top']) {
      expect(container.querySelector(selector), selector).toBeNull();
    }
    expect(screen.queryByText(t('web.dashboard_today_sales'))).toBeNull();
    // What stays: the queue first, the operational section below the card.
    expect(container.querySelector('#dash-attention')).not.toBeNull();
    const label = container.querySelector('.dash-sec') as HTMLElement;
    expect(label.textContent).toBe(t('web.dashboard_operations'));
    expect(card.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(t('web.system_status'))).toBeInTheDocument();
    // And the header controls, so the empty period can be left.
    expect(screen.getByRole('switch', { name: t('web.period_compare') })).toBeInTheDocument();
  });

  it('keeps the full layout for a period with data', async () => {
    stubApi(routesOf(DEMO_PARITY));
    const { container } = renderPage(<DashboardPage permissions={OWNER} superAdmin />);
    await screen.findByText(t('web.dashboard_today_sales'));
    expect(container.querySelector('.dash-empty-period')).toBeNull();
    expect(container.querySelector('.dash-kgrid')).not.toBeNull();
    expect(container.querySelector('.dash-ops')).not.toBeNull();
    expect(container.querySelector('.dash-charts')).not.toBeNull();
  });

  it('decides emptiness from the server’s figures, and any one of them keeps the layout', () => {
    const empty = DEMO_PARITY_EMPTY.find((f) => f.path === '/dashboard/summary')!
      .body as Parameters<typeof periodHasNothing>[0];
    expect(periodHasNothing(empty)).toBe(true);
    const one = (patch: Partial<Parameters<typeof periodHasNothing>[0]['selected']>) =>
      periodHasNothing({ ...empty, selected: { ...empty.selected, ...patch } });
    expect(one({ sales: { current: 1, previous: 0 } })).toBe(false);
    expect(one({ failedPayments: { current: 2, previous: 0 } })).toBe(false);
    expect(one({ newCustomers: { current: 3, previous: 0 } })).toBe(false);
    expect(one({ renewals: { current: 1, previous: 0 } })).toBe(false);
    expect(one({ revenue: [{ currency: 'USDT', current: '1', previous: '0' }] })).toBe(false);
    expect(
      one({
        paymentMethods: [
          { method: 'WALLET', confirmed: 1, confirmedAmount: [{ currency: 'IRT', amount: '0' }] },
        ],
      }),
    ).toBe(false);
  });
});

describe('the attention queue’s layout', () => {
  it('draws severe items as tiles and the rest as rows, the first row on a line of its own', async () => {
    stubApi(routesOf(DEMO_PARITY));
    renderPage(<AttentionQueueCard permissions={OWNER} />);
    const list = await screen.findByRole('list', { name: t('web.dash_attn_title') });
    await waitFor(() => expect(within(list).getAllByRole('link')).toHaveLength(10));
    const items = [...list.querySelectorAll(':scope > li')];
    const kinds = items.map((li) => (li.classList.contains('dash-attn-tile') ? 'tile' : 'row'));
    expect(kinds).toEqual(['tile', 'tile', 'tile', 'tile', ...Array(6).fill('row')]);
    expect(items[4]?.classList.contains('first-normal')).toBe(true);
    expect(items[0]?.querySelector('.dash-attn-count')?.textContent).toBe('1');
    expect(items[4]?.querySelector('.dash-chip')?.textContent).toBe('4');
  });

  it('keeps its side column when nothing waits, and says so in the item area', async () => {
    stubApi(routesOf(DEMO_PARITY_EMPTY));
    const { container } = renderPage(<AttentionQueueCard permissions={OWNER} />);
    await screen.findByText(t('web.dash_attn_clear'));
    const card = container.querySelector('#dash-attention') as HTMLElement;
    expect(card.querySelector('.dash-attn-head h2')?.textContent).toBe(t('web.dash_attn_title'));
    expect(card.querySelector('.dash-attn-body .dash-attn-clear')).not.toBeNull();
  });
});

describe('the movement pill', () => {
  it('is an arrow and a percentage, green for good, red for a bad rise', () => {
    const { container: good } = render(<DeltaPill delta={kpiDelta(12n, 10n, 'up-good')} />);
    expect(good.querySelector('.dash-delta')?.className).toContain('good');
    expect(good.querySelector('svg')).not.toBeNull();
    const { container: bad } = render(<DeltaPill delta={kpiDelta(12n, 10n, 'up-bad')} />);
    expect(bad.querySelector('.dash-delta')?.className).toContain('bad');
  });

  it('draws «جدید» and «—» as neutral pills with no arrow', () => {
    for (const delta of [kpiDelta(5n, 0n, 'up-good'), kpiDelta(0n, 0n, 'up-good')]) {
      const { container } = render(<DeltaPill delta={delta} />);
      const pill = container.querySelector('.dash-delta') as HTMLElement;
      expect(pill.className).toContain('neutral');
      expect(pill.querySelector('svg')).toBeNull();
    }
  });
});

describe('the area spark', () => {
  const geometry = (container: HTMLElement) =>
    [...container.querySelectorAll('path')].map((path) => path.getAttribute('d') ?? '');

  it('draws a flat, centred baseline for all-zero or one-point data', () => {
    for (const values of [[0, 0, 0, 0], [5], [null, 7, null], [3, 3, 3]]) {
      const { container } = render(<AreaSpark values={values} label="x" />);
      const svg = container.querySelector('svg') as SVGElement;
      expect(svg.getAttribute('class')).toContain('flat');
      expect(svg.querySelector('.area')).toBeNull();
      const [d] = geometry(container);
      // Centred: both ends at half the height (the tile's 40 → 20).
      expect(d).toMatch(/^M\d+,20 L\d+,20$/);
    }
  });

  it('fills the area with a gradient, marks the last point, and keeps off the card edge', () => {
    const { container } = render(<AreaSpark values={[0, 0, 0, 0, 900]} label="x" />);
    const area = container.querySelector('path.area') as SVGPathElement;
    expect(area.getAttribute('fill')).toMatch(/^url\(#/);
    expect(container.querySelector('linearGradient')).not.toBeNull();
    const last = container.querySelector('path.last')?.getAttribute('d') ?? '';
    const [x, y] = /^M([\d.]+),([\d.]+) h0$/.exec(last)?.slice(1).map(Number) ?? [NaN, NaN];
    // Inset from the right edge (300) and the top (0): never a spike against the border.
    expect(x).toBeLessThan(300);
    expect(y).toBeGreaterThan(0);
  });
});
