import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { REPORT_EXPORT_HEADERS_FA } from '@nexa/i18n';
import {
  DefaultReportExportWriter,
  cellText,
  headerOf,
} from '../../apps/api/src/infrastructure/export/report-export-writer';
import {
  REPORT_EXPORT_COLUMN_KEYS,
  type ExportTable,
} from '../../apps/api/src/modules/commerce/reporting/application/ports';

/**
 * The CSV and XLSX writers (`docs/wp12-business-analytics-audit.md` §8).
 *
 * Exact numbers, Persian headers, no formula injection, and bytes that depend only on the
 * table — each is a property an export can lose without any report query changing.
 */
const writer = new DefaultReportExportWriter();

const table: ExportTable = {
  report: 'SALES',
  columns: [
    { key: 'orderId', kind: 'text' },
    { key: 'title', kind: 'text' },
    { key: 'orders', kind: 'number' },
    { key: 'total', kind: 'money' },
  ],
  rows: [
    {
      orderId: 'a',
      title: 'Plan, "Gold"',
      orders: 3,
      total: { amountMinor: 1_500_000n, currency: 'IRT' },
    },
    {
      orderId: 'b',
      title: '=HYPERLINK("x")',
      orders: 1,
      total: { amountMinor: 1234n, currency: 'USD' },
    },
    { orderId: 'c', title: null, orders: 0, total: { amountMinor: -5n, currency: 'USD' } },
  ],
};

function unzip(buffer: Uint8Array): Record<string, string> {
  const bytes = Buffer.from(buffer);
  const out: Record<string, string> = {};
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + bytes.readUInt16LE(offset + 28);
    out[name] = inflateRawSync(bytes.subarray(start, start + size)).toString('utf8');
    offset = start + size;
  }
  return out;
}

describe('report export writer', () => {
  it('gives every declared export column a Persian header', () => {
    for (const key of REPORT_EXPORT_COLUMN_KEYS) {
      expect(headerOf(key), key).not.toBe(key);
      expect(REPORT_EXPORT_HEADERS_FA[key]).toMatch(/[؀-ۿ]/u);
    }
  });

  it('writes a UTF-8 CSV with a BOM, CRLF, RFC 4180 quoting and exact money', () => {
    const bytes = Buffer.from(writer.csv(table));
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = bytes.toString('utf8').slice(1).split('\r\n');
    expect(lines[0]).toBe(
      [headerOf('orderId'), headerOf('title'), headerOf('orders'), headerOf('total')].join(','),
    );
    expect(lines[1]).toBe('a,"Plan, ""Gold""",3,1500000');
    // A text cell a spreadsheet would run is neutralised; money is scaled by ITS currency.
    expect(lines[2]).toBe(`b,"'=HYPERLINK(""x"")",1,12.34`);
    expect(lines[3]).toBe('c,,0,-0.05');
    expect(lines[4]).toBe('');
  });

  it('never prefixes a number, only text', () => {
    expect(cellText({ key: 'orders', kind: 'number' }, -3)).toBe('-3');
    expect(cellText({ key: 'title', kind: 'text' }, '-3')).toBe("'-3");
    expect(cellText({ key: 'title', kind: 'text' }, '+98 912')).toBe("'+98 912");
  });

  it('writes an XLSX with numeric cells, inline Persian headers and a right-to-left sheet', () => {
    const files = unzip(writer.xlsx(table));
    const sheet = files['xl/worksheets/sheet1.xml'] ?? '';
    expect(sheet).toContain('rightToLeft="1"');
    expect(sheet).toContain(`<t xml:space="preserve">${headerOf('orderId')}</t>`);
    expect(sheet).toContain('<c r="C2"><v>3</v></c>');
    expect(sheet).toContain('<c r="D2"><v>1500000</v></c>');
    expect(sheet).toContain('<c r="D3"><v>12.34</v></c>');
    expect(sheet).toContain('&apos;=HYPERLINK'.replace('&apos;', "'"));
    expect(sheet).toContain('&quot;Gold&quot;');
    expect(files['xl/workbook.xml']).toContain('name="فروش"');
    expect(files['[Content_Types].xml']).toContain('spreadsheetml.worksheet+xml');
  });

  it('is deterministic: the same table gives the same bytes', () => {
    expect(Buffer.from(writer.xlsx(table)).equals(Buffer.from(writer.xlsx(table)))).toBe(true);
    expect(Buffer.from(writer.csv(table)).equals(Buffer.from(writer.csv(table)))).toBe(true);
  });
});
