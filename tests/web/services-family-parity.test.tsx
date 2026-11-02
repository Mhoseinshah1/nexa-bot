import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { DataTable, type Column } from '../../apps/web/src/ui/kit';
import { formatTimestampNumeric } from '../../apps/web/src/format';
import { renderPage, stubApi } from './harness';
import { ServiceDetailPage, ServicesPage } from '../../apps/web/src/pages/services';
import { CustomServicePage } from '../../apps/web/src/pages/custom-service';
import { ExtraDevicesPage } from '../../apps/web/src/pages/extra-devices';
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

describe('formatTimestampNumeric — the demo list cell «1405/07/14 19:30»', () => {
  it('draws the Jalali date in numbers and the 24-hour time, in Latin digits, left to right', () => {
    const text = formatTimestampNumeric('2026-10-06T16:00:00.000Z');
    // Isolated left to right, so the date stays before the time inside a Persian cell.
    expect(text).toMatch(/^\u20661405\/07\/14 16:00\u2069$/);
    expect(text.startsWith('\u20661405/07/')).toBe(true);
    expect(text).not.toMatch(/[\u06f0-\u06f9]/u);
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

  it('stacks by default, labelling every cell with its header; `stack={false}` opts out', () => {
    // Default since the kit follow-up: the demo stacks every list below 820px.
    const stacked = renderPage(
      <DataTable caption="c" columns={columns} rows={rows} rowKey={(row) => row.id} />,
    );
    const cells = stacked.container.querySelectorAll('td');
    expect([...cells].map((cell) => cell.getAttribute('data-label'))).toEqual(['نام', 'وضعیت']);
    expect(stacked.container.querySelector('.tbl-wrap')).toHaveClass('stack');
    stacked.unmount();

    const plain = renderPage(
      <DataTable
        caption="c"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        stack={false}
      />,
    );
    expect(plain.container.querySelector('td')).not.toHaveAttribute('data-label');
    expect(plain.container.querySelector('.tbl-wrap')).not.toHaveClass('stack');
  });

  it('keeps the table a table for assistive technology while it is stacked', () => {
    renderPage(<DataTable caption="c" columns={columns} rows={rows} rowKey={(row) => row.id} />);
    expect(screen.getByRole('table', { name: 'c' })).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      'نام',
      'وضعیت',
    ]);
    expect(screen.getAllByRole('cell')).toHaveLength(2);
  });

  it("'labelled' keeps the first cell a labelled line instead of the card's title", () => {
    const { container } = renderPage(
      <DataTable
        caption="c"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        stack="labelled"
      />,
    );
    expect(container.querySelector('.tbl-wrap')).toHaveClass('stack', 'labelled');
    expect(container.querySelector('td')).toHaveAttribute('data-label', 'نام');
    expect(KIT_CSS).toContain('.tbl-wrap.stack:not(.labelled) .tbl td:first-child::before');
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
  it('keeps the title’s copy control, drawn as the demo’s hover-revealed `.cpb`', async () => {
    stubApi(routesOf(fixturesFor('demo-parity')));
    renderPage(<ServiceDetailPage id={DETAIL_ID} denied={false} mayEdit mayTerminate mayGrant />);
    const title = (await screen.findByText('saeed_d_1084', { selector: 'h1 *' })).closest('h1')!;
    // The capability stays: a real, focusable copy button for the username.
    const copy = within(title).getByRole('button', { name: t('web.copy') });
    expect(copy).toHaveAttribute('data-copy-value', 'saeed_d_1084');
    const css = readFileSync(
      join(import.meta.dirname, '../../apps/web/src/styles/pages/commerce-a.css'),
      'utf8',
    );
    expect(css).toMatch(/\.ca-title-id > button\[data-copy-value\] \{\s*opacity: 0;/);
    expect(css).toContain('.ca-title-id > button[data-copy-value]:focus-visible');
    expect(css).toMatch(
      /@media \(pointer: coarse\) and \(hover: none\), \(max-width: 820px\) \{\s*\.ca-title-id > button\[data-copy-value\] \{\s*opacity: 1;/,
    );
  });

  it('puts the usage percentage beside a neutral bar («71٪» of 35.3 / 50 GB)', async () => {
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
    // The demo labels the first cell of these two lists too (`'labelled'`).
    for (const wrap of wraps) expect(wrap).toHaveClass('stack', 'labelled');
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
  it('keeps a location panel’s copy control, revealed on the row’s hover as the demo', async () => {
    stubApi(routesOf(fixturesFor('demo-parity')));
    renderPage(<CustomServicePage denied={false} mayEdit mayViewPanels mayViewTiers />);
    const panel = await screen.findByText('DE-1', { selector: '.copyable .val' });
    const row = panel.closest('tr')!;
    expect(within(row).getByRole('button', { name: t('web.copy') })).toBeInTheDocument();
    const css = readFileSync(
      join(import.meta.dirname, '../../apps/web/src/styles/pages/commerce-b.css'),
      'utf8',
    );
    expect(css).toMatch(/\.cs-cards \.copyable > button\[data-copy-value\] \{\s*opacity: 0;/);
    expect(css).toContain('.cs-cards tr:hover .copyable > button[data-copy-value]');
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

describe('extra devices — no scroll jump', () => {
  it('says a refused toggle under the rows, never above the row just clicked', async () => {
    // Only GETs are routed: the toggle's POST is refused by the stub.
    stubApi(routesOf(fixturesFor('demo-parity')).filter((one) => one.method === 'GET'));
    const { container } = renderPage(<ExtraDevicesPage denied={false} mayEdit mayViewPanels />);
    const off = (await screen.findAllByRole('button', { name: 'غیرفعال کردن' }))[0]!;
    fireEvent.click(off);
    await waitFor(() => expect(container.querySelector('.banner.danger')).not.toBeNull());
    const banner = container.querySelector('.banner.danger')!;
    const table = container.querySelector('.tbl-wrap')!;
    expect(table.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
