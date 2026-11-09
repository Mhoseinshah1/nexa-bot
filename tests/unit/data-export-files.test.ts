import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  csvCell,
  csvField,
  csvLine,
  guardFormula,
  UTF8_BOM,
} from '../../apps/api/src/modules/platform/data-export/infrastructure/csv';
import { ZipFileWriter } from '../../apps/api/src/modules/platform/data-export/infrastructure/zip-file-writer';
import { buildDataExportReadme } from '../../apps/api/src/modules/platform/data-export/application/data-export-readme';
import {
  DATA_EXPORT_DATASETS,
  WALLET_BALANCES_DATASET,
} from '../../apps/api/src/modules/platform/data-export/application/data-export-inventory';
import { parseCsv, readZip } from '../support/zip-reader';

/**
 * Phase 6B PR-3: the export's file formats — the CSV (UTF-8 with a BOM so Excel shows Persian,
 * RFC 4180 quoting, no spreadsheet formulas), the streamed ZIP and the README.
 */

const directory = mkdtemp(join(tmpdir(), 'data-export-files-'));
afterAll(async () => rm(await directory, { recursive: true, force: true }));

describe('the CSV', () => {
  it('starts with the UTF-8 byte order mark, so a spreadsheet opens Persian correctly', () => {
    expect(UTF8_BOM).toBe(String.fromCharCode(0xfeff));
    const bytes = Buffer.from(`${UTF8_BOM}${csvLine(['نام', 'x'].map(csvField))}`, 'utf8');
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.subarray(3).toString('utf8')).toBe('نام,x\r\n');
  });

  it('quotes a field with a comma, a quote or a line break, and doubles its quotes', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('two\nlines')).toBe('"two\nlines"');
    expect(csvField('plain')).toBe('plain');
    expect(parseCsv(csvLine(['a,b', 'say "hi"', 'two\nlines', ''].map(csvField)))).toEqual([
      ['a,b', 'say "hi"', 'two\nlines', ''],
    ]);
  });

  it('never lets a text cell run as a spreadsheet formula, and leaves numbers alone', () => {
    for (const evil of ['=HYPERLINK("http://x")', '+1', '-1+1', '@SUM(A1)', '\tx', '\rx']) {
      expect(guardFormula(evil).startsWith("'"), evil).toBe(true);
    }
    expect(csvCell('text', '=cmd')).toBe("'=cmd");
    // A negative balance is a number, not text: it is written as it is.
    expect(csvCell('money_minor', '-500')).toBe('-500');
    expect(csvCell('integer', '-1')).toBe('-1');
    expect(csvCell('text', null)).toBe('');
    expect(csvCell('text', 'علی')).toBe('علی');
  });
});

describe('the ZIP', () => {
  it('writes a well-formed archive of streamed entries, UTF-8 names, exact bytes back', async () => {
    const path = join(await directory, 'a.zip');
    const zip = new ZipFileWriter(path);
    const persian = `${UTF8_BOM}نام,مبلغ\r\nعلی,1000000000000000001\r\n`;
    await zip.addEntry('فارسی.csv', async (push) => {
      await push(persian.slice(0, 5));
      await push(Buffer.from(persian.slice(5), 'utf8'));
    });
    const big = 'x'.repeat(300_000);
    await zip.addEntry('big.csv', async (push) => {
      for (let i = 0; i < 10; i += 1) await push(big);
    });
    await zip.addEntry('empty.csv', async () => undefined);
    await zip.finish();
    const entries = readZip(await readFile(path));
    expect([...entries.keys()]).toEqual(['فارسی.csv', 'big.csv', 'empty.csv']);
    expect(entries.get('فارسی.csv')?.toString('utf8')).toBe(persian);
    expect(entries.get('big.csv')?.length).toBe(3_000_000);
    expect(entries.get('empty.csv')?.length).toBe(0);
  });
});

describe('README.fa.md', () => {
  const readme = buildDataExportReadme({
    tenantDisplayName: 'فروشگاه نمونه',
    tenantSlug: 'sample',
    generatedAt: '2026-01-31T09:30:00.000Z',
    rows: { 'customers.csv': 12, 'wallet_balances.csv': 3 },
  });

  it('describes every column of every file, from the same inventory the export reads', () => {
    for (const dataset of DATA_EXPORT_DATASETS) {
      expect(readme).toContain(`### ${dataset.file}`);
      for (const column of dataset.columns) {
        expect(readme, `${dataset.file}.${column.name}`).toContain(`| \`${column.name}\` |`);
      }
    }
    expect(readme).toContain(`### ${WALLET_BALANCES_DATASET.file}`);
    for (const column of WALLET_BALANCES_DATASET.columns) {
      expect(readme).toContain(`| \`${column.name}\` |`);
    }
  });

  it('is Persian, says money is exact minor units, names the tenant and the row counts', () => {
    expect(readme).toMatch(/[؀-ۿ]/);
    expect(readme).toContain('عدد صحیح به کوچک‌ترین واحد پول');
    expect(readme).toContain('هرگز اعشاری نیستند');
    expect(readme).toContain('فروشگاه نمونه');
    expect(readme).toContain('تعداد ردیف‌ها: 12.');
  });

  it('names no excluded column (a secret is not even mentioned by its column name)', () => {
    for (const dataset of DATA_EXPORT_DATASETS) {
      for (const name of Object.keys(dataset.excluded)) {
        if (dataset.columns.some((column) => column.name === name)) continue;
        // `tenant_id` and `id`-like names appear in prose elsewhere; the secret ones must not.
        if (/token|hash|secret|subscription|resume|idempotency|file_id|client_id/.test(name)) {
          expect(readme, `${dataset.table}.${name}`).not.toContain(`\`${name}\``);
        }
      }
    }
  });
});
