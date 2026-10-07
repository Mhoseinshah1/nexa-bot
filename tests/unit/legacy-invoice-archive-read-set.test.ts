import { describe, expect, it } from 'vitest';
import {
  INVOICE_ARCHIVE_EXCLUDED_COLUMNS,
  INVOICE_ARCHIVE_READ_SET,
  digestInvoiceArchiveReadSet,
} from '../../apps/api/src/modules/platform/legacy-importer/application/invoice-archive-read-set';
import {
  failureFor,
  type InvoicesReadOutcome,
} from '../../apps/api/src/modules/platform/legacy-importer/application/invoice-archive-ingest';
import { InvoiceArchiveStagingRefused } from '../../apps/api/src/modules/platform/legacy-invoice-archive/application/legacy-invoice-archive.service';
import {
  IMPORT_READ_SET_V1,
  LegacySourceRefused,
} from '../../apps/api/src/modules/platform/legacy-importer/application/source-port';
import { readImportV1Identity } from '../../apps/api/src/modules/platform/legacy-importer/application/source-snapshot';
import { FixtureLegacySourceConnector } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/fixture-legacy-source';
import {
  INVOICES_READ_USAGE,
  InvoicesUsageError,
  invoicesReadExitCode,
  invoicesReadReport,
  parseInvoicesReadArgs,
} from '../../apps/api/src/legacy-import-invoices';
import {
  SYNTHETIC_ARCHIVE_SECRETS,
  buildSyntheticLegacyDataset,
  type SyntheticLegacyDataset,
} from '../fixtures/legacy/synthetic-legacy';

/**
 * Mirza migration PR3 — the `invoice-archive` read set and `legacy-import invoices-read`'s
 * command line, over the SYNTHETIC fixture (not evidence).
 */

/** The PR1 golden value (`legacy-import-read-set-v1.test.ts`), restated: reading invoices must not move it. */
const SYNTHETIC_V1_FINGERPRINT = '4b2bc6f8d96f565f665bb9c5f709a0ef0a95727755dd24ee04b23265fc9bf5e3';
const HEX = 'a'.repeat(64);

const open = (dataset: SyntheticLegacyDataset) =>
  new FixtureLegacySourceConnector(dataset as never).open();

function changeEveryInvoice(dataset: SyntheticLegacyDataset, column: string, value: string) {
  return {
    ...dataset,
    tables: {
      ...dataset.tables,
      invoice: dataset.tables.invoice.map((row) => ({ ...row, [column]: value })),
    },
  } as SyntheticLegacyDataset;
}

describe('the invoice-archive read set', () => {
  it('is its own versioned read set: an explicit allowlist, three tables', () => {
    expect(INVOICE_ARCHIVE_READ_SET.fingerprintVersion).toBe('legacy-read-set:invoice-archive:v1');
    const [invoice, user, product] = INVOICE_ARCHIVE_READ_SET.tables;
    // Required: exactly the v1 import read set's invoice columns, which v1 already demands.
    expect(invoice?.table).toBe('invoice');
    expect(invoice?.primaryKey).toBe('id_invoice');
    expect(invoice?.columns).toEqual(IMPORT_READ_SET_V1.requiredColumns.invoice);
    expect(invoice?.optionalColumns).toEqual([
      'Service_location',
      'time_sell',
      'name_product',
      'note',
      'refral',
      'time_cron',
      'notifctions',
    ]);
    // The context tables: keys and codes only — no balance, phone, username or price.
    expect(user).toEqual({ table: 'user', primaryKey: 'id', columns: ['id'], optionalColumns: [] });
    expect(product).toEqual({
      table: 'product',
      primaryKey: 'id',
      columns: ['id', 'code_product'],
      optionalColumns: [],
    });
  });

  it('never names a column that may hold a subscription link, a UUID or a token', () => {
    expect([...INVOICE_ARCHIVE_EXCLUDED_COLUMNS]).toEqual(['user_info', 'uuid', 'bottype']);
    const read = INVOICE_ARCHIVE_READ_SET.tables.flatMap((t) => [
      ...t.columns,
      ...(t.optionalColumns ?? []),
    ]);
    for (const column of read) {
      expect(INVOICE_ARCHIVE_EXCLUDED_COLUMNS as readonly string[]).not.toContain(column);
      expect(column).not.toMatch(/uuid|token|pass|secret|link|url|sub|config|key|card/iu);
    }
  });

  it('reading it leaves the v1 fingerprint exactly the pinned synthetic value', async () => {
    const session = await open(buildSyntheticLegacyDataset());
    expect((await readImportV1Identity(session)).fingerprint).toBe(SYNTHETIC_V1_FINGERPRINT);
    const archive = await digestInvoiceArchiveReadSet(session);
    expect(archive.fingerprint).not.toBe(SYNTHETIC_V1_FINGERPRINT);
    expect((await readImportV1Identity(session)).fingerprint).toBe(SYNTHETIC_V1_FINGERPRINT);
    await session.close();
  });

  it('is deterministic, and moves with every column it reads — never with one it does not', async () => {
    const base = buildSyntheticLegacyDataset({ invoiceArchive: 'A' });
    const digest = async (dataset: SyntheticLegacyDataset) => {
      const session = await open(dataset);
      try {
        return (await digestInvoiceArchiveReadSet(session)).fingerprint;
      } finally {
        await session.close();
      }
    };
    const fingerprint = await digest(base);
    expect(await digest(buildSyntheticLegacyDataset({ invoiceArchive: 'A' }))).toBe(fingerprint);
    expect(await digest(buildSyntheticLegacyDataset({ invoiceArchive: 'B' }))).not.toBe(
      fingerprint,
    );
    for (const column of ['note', 'Status', 'time_sell', 'refral']) {
      expect(await digest(changeEveryInvoice(base, column, 'changed')), column).not.toBe(
        fingerprint,
      );
    }
    // The secrets' VALUES are never read: changing them does not move the fingerprint.
    for (const column of INVOICE_ARCHIVE_EXCLUDED_COLUMNS) {
      expect(await digest(changeEveryInvoice(base, column, 'other secret')), column).toBe(
        fingerprint,
      );
    }
  });

  it('tolerates a source without the optional columns', async () => {
    const session = await open(buildSyntheticLegacyDataset());
    const result = await digestInvoiceArchiveReadSet(session);
    expect(result.tables['invoice']?.columns).not.toContain('note');
    expect(result.tables['invoice']?.columns).toContain('time_sell');
    await session.close();
  });

  it('maps an error during the read to the run failure it stands for', () => {
    expect(failureFor(new LegacySourceRefused('READ_SET_SNAPSHOT_DIVERGED', 'x'))).toBe(
      'SNAPSHOT_DIVERGED',
    );
    expect(failureFor(new InvoiceArchiveStagingRefused('SOURCE_KEY_DUPLICATED', 'x'))).toBe(
      'SOURCE_KEY_DUPLICATED',
    );
    expect(failureFor(new InvoiceArchiveStagingRefused('CELL_UNREPRESENTABLE', 'x'))).toBe(
      'CELL_UNREPRESENTABLE',
    );
    expect(failureFor(new Error('connection reset'))).toBe('INTERRUPTED');
  });
});

describe('legacy-import invoices-read: the command line', () => {
  const base = [
    '--tenant',
    'primary',
    '--source',
    'env:LEGACY_DSN',
    '--target',
    'env:NEXA_DB',
    '--expected-fingerprint',
    HEX,
  ];

  it('parses the digest-only and the approved forms', () => {
    expect(parseInvoicesReadArgs(base)).toMatchObject({
      expectedInvoiceArchiveFingerprint: null,
      batchSize: 1000,
      format: 'md',
      allowProductionTarget: false,
    });
    expect(
      parseInvoicesReadArgs([
        ...base,
        '--expected-invoice-archive-fingerprint',
        'b'.repeat(64),
        '--batch-size',
        '5000',
        '--format',
        'json',
      ]),
    ).toMatchObject({ expectedInvoiceArchiveFingerprint: 'b'.repeat(64), batchSize: 5000 });
  });

  it('refuses what it cannot run safely, before opening anything', () => {
    for (const extra of [
      ['--password', 'x'],
      ['--batch-size', '0'],
      ['--batch-size', '5001'],
      ['--batch-size', 'many'],
      ['--expected-invoice-archive-fingerprint', 'ABC'],
      ['--format', 'csv'],
      ['--unknown', 'x'],
      ['--tenant', 'twice'],
    ]) {
      expect(() => parseInvoicesReadArgs([...base, ...extra]), extra.join(' ')).toThrow(
        InvoicesUsageError,
      );
    }
    expect(() =>
      parseInvoicesReadArgs([
        '--tenant',
        'primary',
        '--source',
        'mysql://u:pw@h/db',
        '--target',
        'x',
        '--expected-fingerprint',
        HEX,
      ]),
    ).toThrow(InvoicesUsageError);
    expect(() => parseInvoicesReadArgs(base.slice(0, 6))).toThrow(/--expected-fingerprint/u);
    expect(INVOICES_READ_USAGE).toContain('--expected-invoice-archive-fingerprint');
  });

  it('reports codes, hashes and counts — never a secret, an id or a username', () => {
    const outcome = {
      v1: {
        fingerprint: HEX,
        schemaHash: HEX,
        tables: {},
        synthetic: true,
        engine: 'SYNTHETIC_FIXTURE',
      },
      fingerprintVersion: 'legacy-read-set:invoice-archive:v1',
      fingerprint: 'c'.repeat(64),
      schemaHash: 'd'.repeat(64),
      synthetic: true,
      rows: { invoice: 10, user: 5, product: 2 },
      abandonedRunId: null,
      finishedEarlierRun: null,
      written: null,
    } as unknown as InvoicesReadOutcome;
    expect(invoicesReadExitCode(outcome)).toBe(3);
    const text = invoicesReadReport(outcome, 'md') + invoicesReadReport(outcome, 'json');
    expect(text).toContain('c'.repeat(64));
    expect(text).toContain('user_info, uuid, bottype');
    for (const secret of Object.values(SYNTHETIC_ARCHIVE_SECRETS))
      expect(text).not.toContain(secret);
  });
});
