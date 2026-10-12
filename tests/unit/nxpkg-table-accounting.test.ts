import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openNxpkg } from '../../apps/api/src/infrastructure/nxpkg/reader';
import {
  decideInventoryVerdict,
  readLegacyInventoryTables,
} from '../../apps/api/src/modules/platform/legacy-importer/application/legacy-inventory';
import {
  classifyFromCoverage,
  parseNxpkgCoverage,
  type NxpkgCoverageEntry,
} from '../../apps/api/src/modules/platform/legacy-importer/application/nxpkg-table-accounting';
import { NxpkgLegacySourceConnector } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/nxpkg-legacy-source';

/**
 * `nxpkg-importer.md` §5a: a package's tables beyond the frozen catalogue are classified from its authenticated
 * coverage report by ONE fixed rule, and anything outside the rule stays UNCLASSIFIED (which
 * a production-like import refuses). Each rule below has the test that fails when it is
 * reverted.
 */

const entry = (over: Partial<Record<string, unknown>>): NxpkgCoverageEntry => {
  const parsed = parseNxpkgCoverage({
    tables: [
      {
        table: 'Payment_report',
        class: 'ARCHIVE',
        status: 'archived',
        rows: 10,
        exported: 0,
        archived: 10,
        review: 0,
        skipped: 0,
        accounted_rows: 10,
        sensitivity: 'financial',
        reason: 'payment history',
        ...over,
      },
    ],
  });
  const one = [...parsed.values()][0];
  if (one === undefined) throw new Error('no entry');
  return one;
};

describe('classifyFromCoverage — the rule', () => {
  it('ARCHIVE / REVIEW / CONFIGURATION with every row accounted → ARCHIVE (history)', () => {
    for (const klass of ['ARCHIVE', 'REVIEW', 'CONFIGURATION']) {
      expect(classifyFromCoverage(entry({ class: klass }), 10).class).toBe('ARCHIVE');
    }
  });

  it('a history table with rows not all accounted, or blocked, is UNCLASSIFIED', () => {
    expect(classifyFromCoverage(entry({ accounted_rows: 9 }), 10).class).toBe('UNCLASSIFIED');
    expect(classifyFromCoverage(entry({ status: 'blocked' }), 10).class).toBe('UNCLASSIFIED');
  });

  it('the coverage row count must equal the source catalogue’s', () => {
    expect(classifyFromCoverage(entry({}), 11).class).toBe('UNCLASSIFIED');
  });

  it('no coverage row at all is UNCLASSIFIED', () => {
    expect(classifyFromCoverage(undefined, 10).class).toBe('UNCLASSIFIED');
  });

  it('EXCLUDED: secret → SECRETS_MANUAL; otherwise OWNER_DECISION; never if rows were carried', () => {
    const excluded = { class: 'EXCLUDED', status: 'excluded', archived: 0, skipped: 10 };
    expect(classifyFromCoverage(entry({ ...excluded, sensitivity: 'secret' }), 10).class).toBe(
      'SECRETS_MANUAL',
    );
    expect(classifyFromCoverage(entry({ ...excluded, sensitivity: 'personal' }), 10).class).toBe(
      'OWNER_DECISION',
    );
    expect(
      classifyFromCoverage(entry({ ...excluded, sensitivity: 'secret', archived: 1 }), 10).class,
    ).toBe('UNCLASSIFIED');
  });

  it('a table unknown to the converter: empty → OWNER_DECISION, non-empty → UNCLASSIFIED', () => {
    expect(classifyFromCoverage(entry({ class: null, rows: 0, accounted_rows: 0 }), 0).class).toBe(
      'OWNER_DECISION',
    );
    expect(classifyFromCoverage(entry({ class: null, status: 'blocked' }), 10).class).toBe(
      'UNCLASSIFIED',
    );
  });

  it('OPERATIONAL outside the frozen catalogue is never accepted', () => {
    expect(classifyFromCoverage(entry({ class: 'OPERATIONAL' }), 10).class).toBe('UNCLASSIFIED');
  });
});

describe('parseNxpkgCoverage — strict', () => {
  const row = {
    table: 't',
    class: 'ARCHIVE',
    status: 'archived',
    rows: 1,
    archived: 1,
    accounted_rows: 1,
  };
  it('refuses a malformed report', () => {
    expect(() => parseNxpkgCoverage([])).toThrow(/tables/u);
    expect(() => parseNxpkgCoverage({ tables: [row, row] })).toThrow(/twice/u);
    expect(() => parseNxpkgCoverage({ tables: [{ ...row, class: 'WHATEVER' }] })).toThrow(
      /unknown class/u,
    );
    expect(() => parseNxpkgCoverage({ tables: [{ ...row, rows: -1 }] })).toThrow(/rows/u);
    expect(() => parseNxpkgCoverage({ tables: [{ ...row, table: 'a b' }] })).toThrow(/identifier/u);
    expect(() => parseNxpkgCoverage({ tables: [{ ...row, status: 7 }] })).toThrow(/status/u);
  });
  it('reads a well-formed row', () => {
    const parsed = parseNxpkgCoverage({ tables: [row] }).get('t');
    expect(parsed).toMatchObject({ converterClass: 'ARCHIVE', rows: 1, accountedRows: 1 });
  });
});

describe('the converter-written fixture package: every table is classified', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'nexa-nxpkg-accounting-'));
  });
  afterAll(async () => rm(root, { recursive: true, force: true }));

  it('the inventory of the cross-language fixture has no UNCLASSIFIED table', async () => {
    const dir = join(__dirname, '../fixtures/nxpkg');
    const keyFileText = await readFile(join(dir, 'synthetic-keyfile.nxkey'), 'utf8');
    const pkg = await openNxpkg(
      join(dir, 'synthetic-keyfile.nxpkg'),
      { keyFileText },
      {
        workDir: root,
        maxPayloadBytes: 64 * 1024 * 1024,
        maxFiles: 1000,
        maxFileBytes: 64 * 1024 * 1024,
      },
    );
    try {
      const connector = await NxpkgLegacySourceConnector.fromPackage(pkg);
      expect(connector.coverage).not.toBeNull();
      const session = await connector.open();
      try {
        const { tables } = await readLegacyInventoryTables(session);
        // More than the frozen catalogue's three: the synthetic backup has history tables.
        expect(tables.length).toBeGreaterThan(4);
        expect(tables.filter((t) => t.class === 'UNCLASSIFIED').map((t) => t.name)).toEqual([]);
        // The frozen catalogue still decides its own tables.
        expect(tables.find((t) => t.name === 'user')?.class).toBe('SUPPORTED');
        expect(tables.some((t) => t.class === 'ARCHIVE')).toBe(true);
        expect(decideInventoryVerdict(tables, true)).toBe('COMPLETE');

        // Without the coverage report (a source that is not a package) the same tables are
        // UNCLASSIFIED: the classification is the package's, never a default.
        const bare = { ...session };
        delete (bare as { packageClassification?: unknown }).packageClassification;
        const without = await readLegacyInventoryTables(bare);
        expect(without.tables.some((t) => t.class === 'UNCLASSIFIED')).toBe(true);
        expect(decideInventoryVerdict(without.tables, true)).toBe('UNCLASSIFIED_TABLES');
      } finally {
        await session.close();
      }
    } finally {
      await pkg.close();
    }
  });
});
