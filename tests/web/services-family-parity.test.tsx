import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DataTable, type Column } from '../../apps/web/src/ui/kit';
import { formatTimestampNumeric } from '../../apps/web/src/format';
import { renderPage } from './harness';

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
  it('draws the Jalali date in numbers and the 24-hour time, in Persian digits', () => {
    const text = formatTimestampNumeric('2026-10-06T16:00:00.000Z');
    expect(text).toMatch(/^[۰-۹]{4}\/[۰-۹]{2}\/[۰-۹]{2} [۰-۹]{2}:[۰-۹]{2}$/);
    expect(text.startsWith('۱۴۰۵/۰۷/')).toBe(true);
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
