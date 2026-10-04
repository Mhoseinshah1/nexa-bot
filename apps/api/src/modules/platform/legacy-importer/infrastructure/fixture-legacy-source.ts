import { readFile } from 'node:fs/promises';
import {
  EvidenceUnsupported,
  LEGACY_PRIMARY_KEYS,
  LEGACY_SOURCE_TABLES,
  LegacySourceRefused,
  compareKeyBytes,
  type LegacyCell,
  type LegacySchemaColumn,
  type LegacySourceConnector,
  type LegacySourceSession,
  type LegacySourceTableName,
} from '../application/source-port.js';

/**
 * Migration P7 — a SYNTHETIC legacy source held in memory, from a fixture file
 * (`tests/fixtures/legacy/`). It exists so the importer's code can be exercised — by the
 * test suites and by REHEARSE's dry runs — without a MySQL server.
 *
 * It refuses any dataset that does not declare itself synthetic (`synthetic: true` and a
 * label containing `SYNTHETIC`), and the engine it reports is `SYNTHETIC_FIXTURE`, which
 * every report prints in its header. The CLI refuses it against a production-like target
 * whatever the acknowledgement says (`production-guard.ts`).
 *
 * Rows come back in the same canonical order as the MySQL adapter's
 * (`ORDER BY CAST(pk AS BINARY)`): the key's UTF-8 bytes. The same dataset loaded into
 * MariaDB therefore fingerprints identically — the opt-in MariaDB suite checks exactly
 * that.
 */

export interface LegacyFixtureDataset {
  readonly synthetic: true;
  readonly label: string;
  readonly schema: readonly LegacySchemaColumn[];
  readonly tables: Readonly<Record<string, readonly Readonly<Record<string, LegacyCell>>[]>>;
}

export function assertSyntheticDataset(value: unknown): LegacyFixtureDataset {
  const candidate = value as Partial<LegacyFixtureDataset> | null;
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    candidate.synthetic !== true ||
    typeof candidate.label !== 'string' ||
    !candidate.label.includes('SYNTHETIC') ||
    !Array.isArray(candidate.schema) ||
    typeof candidate.tables !== 'object' ||
    candidate.tables === null
  ) {
    throw new LegacySourceRefused(
      'SOURCE_UNREADABLE',
      'a fixture source must be a dataset that declares itself SYNTHETIC',
    );
  }
  return candidate as LegacyFixtureDataset;
}

export async function loadFixtureDataset(path: string): Promise<LegacyFixtureDataset> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new LegacySourceRefused('SOURCE_UNREADABLE', 'the fixture file cannot be read');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LegacySourceRefused('SOURCE_UNREADABLE', 'the fixture file is not JSON');
  }
  return assertSyntheticDataset(parsed);
}

export class FixtureLegacySourceConnector implements LegacySourceConnector {
  readonly label: string;

  constructor(private readonly dataset: LegacyFixtureDataset) {
    assertSyntheticDataset(dataset);
    this.label = `fixture ${dataset.label}`;
  }

  open(): Promise<LegacySourceSession> {
    const dataset = this.dataset;
    let closed = false;
    const live = () => {
      if (closed) throw new Error('the fixture session is closed');
    };
    return Promise.resolve({
      descriptor: {
        engine: 'SYNTHETIC_FIXTURE',
        version: dataset.label,
        readOnlyProof: { kind: 'NOT_APPLICABLE' },
      },
      columns: () => {
        live();
        return Promise.resolve(dataset.schema);
      },
      rows: (table: LegacySourceTableName, columns: readonly string[]) => {
        live();
        if (!(LEGACY_SOURCE_TABLES as readonly string[]).includes(table)) {
          throw new Error('not a legacy source table');
        }
        const pk = LEGACY_PRIMARY_KEYS[table];
        const rows = [...(dataset.tables[table] ?? [])].sort((a, b) =>
          compareKeyBytes(a[pk] ?? '', b[pk] ?? ''),
        );
        return (async function* () {
          for (const row of rows) yield columns.map((c) => row[c] ?? null);
        })();
      },
      aggregate: () => Promise.reject(new EvidenceUnsupported()),
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    });
  }
}
