import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { DataTable, type Column } from '../../apps/web/src/ui/kit';
import { formatTimestampNumeric } from '../../apps/web/src/format';
import { renderPage, stubApi } from './harness';
import { ServiceDetailPage, ServicesPage } from '../../apps/web/src/pages/services';
import { CustomServicePage } from '../../apps/web/src/pages/custom-service';
import { AudienceBuilder, EMPTY_AUDIENCE } from '../../apps/web/src/pages/audience-builder';
import { t } from '../../apps/web/src/i18n/web.fa';
import { fixturesFor } from './shots/index.ts';
import type { ShotFixture } from './shots/fixture.ts';
import { DEMO_SERVICES_FAMILY } from './shots/fixtures/demo-parity/services.ts';

/**
 * Demo parity for the services family (services, orders, extra devices, custom service,
 * service locations, trials, compensations, bulk operations): the rules the approved demo
 * draws on these pages, each pinned once.
 */

const KIT_CSS = readFileSync(
  join(import.meta.dirname, '../../apps/web/src/styles/kit.css'),
  'utf8',
);

describe('formatTimestampNumeric — the demo list cell «۱۴۰۵/۰۷/۱۴ ۱۹:۳۰»', () => {
  it('draws the Jalali date in numbers and the 24-hour time, in Persian digits, left to right', () => {
    const text = formatTimestampNumeric('2026-10-06T16:00:00.000Z');
    // Isolated left to right, so the date stays before the time inside a Persian cell.
    expect(text).toMatch(/^\u2066[۰-۹]{4}\/[۰-۹]{2}\/[۰-۹]{2} [۰-۹]{2}:[۰-۹]{2}\u2069$/);
    expect(text.startsWith('\u2066۱۴۰۵/۰۷/')).toBe(true);
    expect(text).not.toMatch(/[0-9]/);
  });

  it('returns an unparseable string unchanged, as formatTimestamp does', () => {
    expect(formatTimestampNumeric('not a date')).toBe('not a date');
  });
});

describe('DataTable stack — one card per row at phone width, as the demo', () => {
  interface Row {
    readonly id: string;
    readonly name: string;
    readonly state: string;
  }
  const columns: readonly Column<Row>[] = [
    { key: 'name', header: 'نام', render: (row) => row.name },
    { key: 'state', header: 'وضعیت', render: (row) => row.state },
  ];
  const rows: readonly Row[] = [{ id: 'a', name: 'یک', state: 'فعال' }];

  it('labels every cell with its header and marks the wrap only when asked', () => {
    const stacked = renderPage(
      <DataTable caption="c" columns={columns} rows={rows} rowKey={(row) => row.id} stack />,
    );
    const cells = stacked.container.querySelectorAll('td');
    expect([...cells].map((cell) => cell.getAttribute('data-label'))).toEqual(['نام', 'وضعیت']);
    expect(stacked.container.querySelector('.tbl-wrap')).toHaveClass('stack');
    stacked.unmount();

    const plain = renderPage(
      <DataTable caption="c" columns={columns} rows={rows} rowKey={(row) => row.id} />,
    );
    expect(plain.container.querySelector('td')).not.toHaveAttribute('data-label');
    expect(plain.container.querySelector('.tbl-wrap')).not.toHaveClass('stack');
  });

  it('the stylesheet draws the label from data-label and keeps the header row for readers', () => {
    const at = KIT_CSS.indexOf('@media (max-width: 820px) {\n  .tbl-wrap.stack,');
    expect(at).toBeGreaterThan(-1);
    const block = KIT_CSS.slice(at, KIT_CSS.indexOf('\n}\n', at));
    expect(block).toContain('content: attr(data-label)');
    expect(block).toContain('clip-path: inset(50%)');
    expect(block).not.toContain('display: none');
  });
});

describe('the services family demo-parity fixtures', () => {
  it.each(
    DEMO_SERVICES_FAMILY.map((fixture) => [`${fixture.method} ${fixture.path}`, fixture] as const),
  )('%s satisfies its response schema', (_, fixture) => {
    expect(() => fixture.schema?.parse(fixture.body)).not.toThrow();
  });
});

/*
 * The pages, against the same demo-parity bodies the side-by-sides photograph. A fixture
 * path's `:id` is answered for the one id each test opens.
 */
const DETAIL_ID = '019250ab-cdef-7012-8345-6791abcdef01';

function routesOf(set: readonly ShotFixture[]) {
  const seen = new Set<string>();
  return set
    .filter((fixture) => {
      const key = `${fixture.method} ${fixture.path}`;
      if (seen.has(key) || Object.keys(fixture.query).length > 0) return false;
      seen.add(key);
      return true;
    })
    .map((fixture) => ({
      url: fixture.path.replace(':id', DETAIL_ID),
      method: fixture.method,
      body: fixture.body,
    }));
}

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('services detail, as the demo draws it', () => {
  it('titles the page with the bare username — no copy icon (X7)', async () => {
    stubApi(routesOf(fixturesFor('demo-parity')));
    renderPage(<ServiceDetailPage id={DETAIL_ID} denied={false} mayEdit mayTerminate mayGrant />);
    const title = (await screen.findByText('saeed_d_1084', { selector: 'h1 *' })).closest('h1')!;
    const head = title.closest('header') ?? title.parentElement!;
    expect(within(head).queryByRole('button', { name: t('web.copy') })).toBeNull();
  });

  it('puts the usage percentage beside a neutral bar («۷۱٪» of 35.3 / 50 GB)', async () => {
    stubApi(routesOf(fixturesFor('demo-parity')));
    renderPage(<ServiceDetailPage id={DETAIL_ID} denied={false} mayEdit mayTerminate mayGrant />);
    const bar = await screen.findByRole('progressbar', { name: t('web.service_traffic_used') });
    expect(bar).toHaveAttribute('aria-valuenow', '71');
    expect(bar).toHaveClass('neutral');
    expect(bar.closest('.svc-usage-meter')?.textContent).toContain(`71${t('web.percent_sign')}`);
  });

  it('draws the expiry as the smaller date line, not a 24px figure', async () => {
    stubApi(routesOf(fixturesFor('demo-parity')));
    const { container } = renderPage(
      <ServiceDetailPage id={DETAIL_ID} denied={false} mayEdit mayTerminate mayGrant />,
    );
    await screen.findByText('saeed_d_1084', { selector: 'h1 *' });
    expect(container.querySelector('.ca-stats .stat .val .ca-stat-when')).not.toBeNull();
  });
});

describe('the services list and its refund queue', () => {
  it('stacks the list at phone width and lets the queue’s outcome and time wrap (X9)', async () => {
    stubApi([
      ...routesOf(fixturesFor('demo-parity')),
      {
        url: '/service-refund-requests',
        body: fixturesFor('demo-parity').find(
          (one) => one.path === '/service-refund-requests' && one.query['attention'] === 'true',
        )!.body,
      },
    ]);
    window.history.replaceState(null, '', '/services');
    const { container } = renderPage(
      <ServicesPage
        route={{ path: '/services', query: new URLSearchParams() }}
        denied={false}
        mayViewRefundRequests
      />,
    );
    await screen.findByText('trial_parisa_h');
    await screen.findByText('omid_sh_1087');
    const wraps = [...container.querySelectorAll('.tbl-wrap')];
    expect(wraps.length).toBeGreaterThanOrEqual(2);
    for (const wrap of wraps) expect(wrap).toHaveClass('stack');
    const queue = screen.getByText('omid_sh_1087').closest('tr')!;
    const cells = [...queue.querySelectorAll('td')];
    const outcome = cells.find(
      (cell) => cell.getAttribute('data-label') === t('web.service_refund_outcome'),
    )!;
    const created = cells.find(
      (cell) => cell.getAttribute('data-label') === t('web.service_refund_created'),
    )!;
    expect(outcome).toHaveClass('wrap', 'tight');
    expect(created).toHaveClass('wrap', 'tight');
  });
});

describe('custom service, as the demo draws it', () => {
  it('names a location’s panel without a copy icon (X7)', async () => {
    stubApi(routesOf(fixturesFor('demo-parity')));
    renderPage(<CustomServicePage denied={false} mayEdit mayViewPanels mayViewTiers />);
    const panel = await screen.findByText('Frankfurt A', { selector: '.id-text' });
    const row = panel.closest('tr')!;
    expect(within(row).queryByRole('button', { name: t('web.copy') })).toBeNull();
  });

  it('keeps each card’s action level with its title', () => {
    const css = readFileSync(
      join(import.meta.dirname, '../../apps/web/src/styles/pages/commerce-b.css'),
      'utf8',
    );
    expect(css).toMatch(/\.cs-cards > \.card > \.card-head \{\s*align-items: flex-start;/);
  });
});

describe('a new mass operation’s audience', () => {
  it('reads «مخاطبان این عملیات» before the figure, on one line', async () => {
    stubApi([
      {
        url: '/audience/preview',
        method: 'POST',
        body: fixturesFor('demo-parity').find((one) => one.path === '/audience/preview')!.body,
      },
    ]);
    renderPage(<AudienceBuilder value={EMPTY_AUDIENCE} onChange={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('audience-customers').textContent).not.toBe('—'));
    expect(t('web.aq_count_title')).toBe('مخاطبان این عملیات');
    const ui = readFileSync(join(import.meta.dirname, '../../apps/web/src/styles/ui.css'), 'utf8');
    expect(ui).toMatch(/\.aq-count-title \{\s*flex-basis: auto;/);
    expect(ui).toMatch(/\.aq-count b \{\s*font-size: 26px;/);
  });
});
