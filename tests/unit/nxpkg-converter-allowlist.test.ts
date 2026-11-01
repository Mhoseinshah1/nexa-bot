import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INVOICE_ARCHIVE_READ_SET } from '../../apps/api/src/modules/platform/legacy-importer/application/invoice-archive-read-set';
import { PRODUCTS_READ_SET } from '../../apps/api/src/modules/platform/legacy-importer/application/products-read-set';
import {
  USER_STATUS_READ_SET,
  USER_TERMS_READ_SET,
  type LegacyReadSetDefinition,
} from '../../apps/api/src/modules/platform/legacy-importer/application/read-set';
import {
  LEGACY_OPTIONAL_COLUMNS,
  LEGACY_REQUIRED_COLUMNS,
  LEGACY_SOURCE_TABLES,
} from '../../apps/api/src/modules/platform/legacy-importer/application/source-port';

/**
 * Contract guard: every column NEXA's importer reads from the `.nxpkg` source snapshot's
 * `user`, `invoice` and `product` rows files must be one the converter carries
 * (`docs/legacy-migration/nxpkg-importer.md` §3a). The converter's `ALLOWLIST` is vendored in
 * `tests/fixtures/legacy/converter-allowlist.json`.
 *
 * An OPTIONAL column the converter leaves out does not fail an import (it is read as absent),
 * but its information is silently lost — converter 0.8.0 left out `user.roll_Status`, and every
 * customer would have imported as "rules not accepted". So optional columns are guarded too.
 */

interface ConverterAllowlist {
  readonly converter: string;
  readonly version: string;
  readonly source: string;
  readonly allowlist: Readonly<Record<string, readonly string[]>>;
}

const FIXTURE = join(__dirname, '../fixtures/legacy/converter-allowlist.json');
const SRC = join(__dirname, '../../apps/api/src');

/** Every read set the importer defines. A new one must be added here (see the scan below). */
const READ_SETS: readonly LegacyReadSetDefinition[] = [
  USER_STATUS_READ_SET,
  USER_TERMS_READ_SET,
  PRODUCTS_READ_SET,
  INVOICE_ARCHIVE_READ_SET,
];

const SNAPSHOT_TABLES: readonly string[] = LEGACY_SOURCE_TABLES;

/** `table.column` → who reads it, for every snapshot-table column NEXA reads. */
function importerReads(readSets: readonly LegacyReadSetDefinition[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (table: string, column: string, by: string) => {
    const key = `${table}.${column}`;
    out.set(key, [...(out.get(key) ?? []), by]);
  };
  for (const table of LEGACY_SOURCE_TABLES) {
    for (const c of LEGACY_REQUIRED_COLUMNS[table]) add(table, c, 'import v1 (required)');
    for (const c of LEGACY_OPTIONAL_COLUMNS[table]) add(table, c, 'import v1 (optional)');
  }
  for (const set of readSets) {
    for (const spec of set.tables) {
      if (!SNAPSHOT_TABLES.includes(spec.table)) continue;
      for (const c of spec.columns) add(spec.table, c, `${set.fingerprintVersion} (required)`);
      for (const c of spec.optionalColumns ?? []) {
        add(spec.table, c, `${set.fingerprintVersion} (optional)`);
      }
    }
  }
  return out;
}

/** The guard's verdict: one bilingual line per column NEXA reads that the converter drops. */
function notCarried(reads: Map<string, string[]>, converter: ConverterAllowlist): string[] {
  const problems: string[] = [];
  for (const [column, by] of [...reads].sort(([a], [b]) => a.localeCompare(b))) {
    const [table = '', name = ''] = column.split('.');
    if ((converter.allowlist[table] ?? []).includes(name)) continue;
    problems.push(
      `${column} (read by ${by.join(', ')}): NEXA reads this column but ` +
        `${converter.converter} ${converter.version} does not carry it in the package — ` +
        `add it to mirza-to-nexa ALLOWLIST (${converter.source}). / ` +
        `ستون ${column} را واردکنندهٔ NEXA می‌خواند ولی ${converter.converter} ` +
        `${converter.version} آن را در بسته نمی‌گذارد؛ آن را به ALLOWLIST در mirza-to-nexa ` +
        `اضافه کنید (add it to mirza-to-nexa ALLOWLIST).`,
    );
  }
  return problems;
}

function loadFixture(): ConverterAllowlist {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as ConverterAllowlist;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') ? [path] : [];
  });
}

describe('the converter carries every snapshot column NEXA reads', () => {
  it('the vendored allowlist names the converter, its version and the snapshot tables', () => {
    const fixture = loadFixture();
    expect(fixture.converter).toBe('mirza-to-nexa');
    expect(fixture.version).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(Object.keys(fixture.allowlist).sort()).toEqual([...SNAPSHOT_TABLES].sort());
  });

  it('every column of the v1 import and of every read set over user/invoice/product is in the converter ALLOWLIST', () => {
    const problems = notCarried(importerReads(READ_SETS), loadFixture());
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('every read set the importer defines is checked here', () => {
    // `export const X = defineLegacyReadSet(` anywhere in the API: each must be in READ_SETS,
    // so a new read set cannot read a snapshot column the converter does not carry unseen.
    const defined = sourceFiles(SRC).flatMap((file) =>
      [
        ...readFileSync(file, 'utf8').matchAll(/^export const (\w+) = defineLegacyReadSet\(/gmu),
      ].map((m) => `${relative(SRC, file)}:${m[1] ?? ''}`),
    );
    expect(defined.length, defined.join('\n')).toBe(READ_SETS.length);
  });

  it('the guard names a dropped column, bilingually (roll_Status, as converter 0.8.0 dropped it)', () => {
    const fixture = loadFixture();
    const dropped: ConverterAllowlist = {
      ...fixture,
      version: '0.8.0',
      allowlist: {
        ...fixture.allowlist,
        user: (fixture.allowlist['user'] ?? []).filter((c) => c !== 'roll_Status'),
      },
    };
    const problems = notCarried(importerReads(READ_SETS), dropped);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('user.roll_Status');
    expect(problems[0]).toContain('legacy-read-set:user-terms:v1 (optional)');
    expect(problems[0]).toContain('add it to mirza-to-nexa ALLOWLIST');
    expect(problems[0]).toContain('ستون user.roll_Status');
  });
});
