import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ProviderHttpClient, ProviderHttpRequest } from '@nexa/contracts';
import {
  boundedCell,
  crossCheckEvidence,
  type LegacyEvidence,
} from '../../apps/api/src/modules/platform/legacy-importer/application/evidence-runner';
import { planLegacyImport } from '../../apps/api/src/modules/platform/legacy-importer/application/plan';
import { parsePanelMapping } from '../../apps/api/src/modules/platform/legacy-importer/application/panel-mapping';
import {
  LEGACY_REPORT_FORMAT,
  reportJson,
  reportMarkdown,
} from '../../apps/api/src/modules/platform/legacy-importer/application/report';
import { LEGACY_EVIDENCE_QUERIES } from '../../apps/api/src/modules/platform/legacy-importer/application/sql-evidence';
import { LegacySourceRefused } from '../../apps/api/src/modules/platform/legacy-importer/application/source-port';
import { readFromSession } from '../../apps/api/src/modules/platform/legacy-importer/application/source-snapshot';
import {
  FixtureLegacySourceConnector,
  assertSyntheticDataset,
} from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/fixture-legacy-source';
import {
  parseMysqlDsn,
  mysqlSourceLabel,
} from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/mysql-legacy-source';
import { readOnlyGuard } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/rickpanel-inventory-source';
import { TOKEN_PATH } from '../../apps/api/src/modules/platform/providers/infrastructure/rickpanel-protocol';
import {
  SYNTHETIC_LABEL,
  buildSyntheticLegacyDataset,
  syntheticLegacySql,
  type SyntheticLegacyDataset,
} from '../fixtures/legacy/synthetic-legacy';
import { syntheticInventories, syntheticMappingFile } from '../fixtures/legacy/synthetic-support';

/**
 * Migration P7 — the source side: the snapshot and its fingerprint, the fixture source,
 * the evidence catalogue against the runbook, the report, and the provider read guard.
 * The MySQL engine itself is exercised by the opt-in `legacy-mysql` project.
 */

async function snapshotOf(dataset: SyntheticLegacyDataset) {
  const connector = new FixtureLegacySourceConnector(dataset as never);
  return readFromSession(connector.label, await connector.open());
}

function mutate(
  table: 'user' | 'invoice' | 'product',
  index: number,
  column: string,
  value: string | null,
): SyntheticLegacyDataset {
  const dataset = buildSyntheticLegacyDataset();
  const rows = dataset.tables[table].map((r, i) => (i === index ? { ...r, [column]: value } : r));
  return { ...dataset, tables: { ...dataset.tables, [table]: rows } };
}

describe('the fingerprint', () => {
  it('is deterministic, and independent of row order in the source', async () => {
    const a = await snapshotOf(buildSyntheticLegacyDataset());
    const shuffled = buildSyntheticLegacyDataset();
    const b = await snapshotOf({
      ...shuffled,
      tables: {
        ...shuffled.tables,
        user: [...shuffled.tables.user].reverse(),
        invoice: [...shuffled.tables.invoice].reverse(),
      },
    });
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(a.tables.user.rows).toBe(11);
    expect(a.tables.invoice.rows).toBe(21);
  });

  it('changes when any column the import decides from changes', async () => {
    const base = (await snapshotOf(buildSyntheticLegacyDataset())).fingerprint;
    for (const [table, column] of [
      ['user', 'Balance'],
      ['user', 'limit_usertest'],
      ['user', 'agent'],
      ['user', 'username'],
      ['invoice', 'Status'],
      ['invoice', 'code_panel'],
      ['invoice', 'username'],
      ['invoice', 'is_test'],
      ['invoice', 'Volume'],
      ['invoice', 'price_product'],
      ['product', 'code_product'],
    ] as const) {
      const changed = await snapshotOf(mutate(table, 0, column, 'changed'));
      expect(changed.fingerprint, `${table}.${column}`).not.toBe(base);
    }
  });

  it('does not take the phone into account, and reports no row value', async () => {
    const base = await snapshotOf(buildSyntheticLegacyDataset());
    const phone = await snapshotOf(mutate('user', 0, 'number', '989000000000'));
    expect(phone.fingerprint).toBe(base.fingerprint);
    expect(base.tables.user.columns).not.toContain('number');
  });

  it('changes with the schema, and refuses a source missing a required column', async () => {
    const dataset = buildSyntheticLegacyDataset();
    const retyped = await snapshotOf({
      ...dataset,
      schema: dataset.schema.map((c) => (c.column === 'Balance' ? { ...c, dataType: 'int' } : c)),
    });
    expect(retyped.fingerprint).not.toBe((await snapshotOf(dataset)).fingerprint);
    await expect(
      snapshotOf({
        ...dataset,
        schema: dataset.schema.filter((c) => !(c.table === 'invoice' && c.column === 'code_panel')),
      }),
    ).rejects.toThrow(LegacySourceRefused);
    await expect(
      snapshotOf({ ...dataset, schema: dataset.schema.filter((c) => c.table !== 'product') }),
    ).rejects.toThrow(/SOURCE_SCHEMA_MISSING_TABLE/u);
  });

  it('per-row checksums move with the row and only with it', async () => {
    const base = await snapshotOf(buildSyntheticLegacyDataset());
    const changed = await snapshotOf(mutate('user', 0, 'Balance', '1'));
    const id = buildSyntheticLegacyDataset().tables.user[0]?.['id'];
    const before = base.users.find((u) => u.id === id);
    const after = changed.users.find((u) => u.id === id);
    expect(after?.checksum).not.toBe(before?.checksum);
    const other = base.users.find((u) => u.id === '100000011');
    expect(changed.users.find((u) => u.id === '100000011')?.checksum).toBe(other?.checksum);
  });
});

describe('the SYNTHETIC fixture', () => {
  it('the committed JSON and SQL are exactly what the generator writes', () => {
    const dataset = buildSyntheticLegacyDataset();
    const json = readFileSync('tests/fixtures/legacy/synthetic-legacy.json', 'utf8');
    expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(dataset)));
    expect(readFileSync('tests/fixtures/legacy/synthetic-legacy.sql', 'utf8')).toBe(
      syntheticLegacySql(dataset),
    );
  });

  it('is labelled SYNTHETIC everywhere, and a dataset that is not is refused', () => {
    const dataset = buildSyntheticLegacyDataset();
    expect(dataset.label).toContain('SYNTHETIC');
    expect(syntheticLegacySql(dataset).split('\n')[0]).toContain('SYNTHETIC');
    expect(SYNTHETIC_LABEL).toContain('not evidence');
    expect(() => assertSyntheticDataset({ ...dataset, synthetic: false })).toThrow(
      LegacySourceRefused,
    );
    expect(() => assertSyntheticDataset({ ...dataset, label: 'production dump' })).toThrow(
      LegacySourceRefused,
    );
  });

  it('reports itself as a SYNTHETIC_FIXTURE with no write path and no SQL', async () => {
    const connector = new FixtureLegacySourceConnector(buildSyntheticLegacyDataset() as never);
    const session = await connector.open();
    expect(session.descriptor).toMatchObject({
      engine: 'SYNTHETIC_FIXTURE',
      readOnlyProof: { kind: 'NOT_APPLICABLE' },
    });
    await expect(session.aggregate('SELECT 1')).rejects.toThrow(/no SQL engine/u);
  });

  it('extra users scale the dataset without changing the branch rows', () => {
    const big = buildSyntheticLegacyDataset({ extraUsers: 50 });
    expect(big.tables.user).toHaveLength(61);
    expect(big.tables.invoice).toHaveLength(21);
  });
});

describe('the evidence catalogue is the runbook, verbatim', () => {
  const runbook = readFileSync('docs/legacy-migration/sql-evidence.md', 'utf8');
  const blocks = [...runbook.matchAll(/```sql\n([\s\S]*?)```/gu)].map((m) => m[1] as string);

  it('every runner query is a runbook statement, character for character', () => {
    const statements = blocks.flatMap((b) =>
      b.includes(';\n\nSELECT') ? b.split(/(?<=;\n)\n/u) : [b],
    );
    for (const query of LEGACY_EVIDENCE_QUERIES) {
      expect(statements, query.id).toContain(query.sql);
    }
  });

  it('covers Q1–Q7, Q1b, Q1c and Q2b and nothing else', () => {
    expect(LEGACY_EVIDENCE_QUERIES.map((q) => q.id)).toEqual([
      'Q1',
      'Q1b',
      'Q1c_time_unit',
      'Q1c_volume',
      'Q2',
      'Q2b',
      'Q3',
      'Q4',
      'Q5',
      'Q6',
      'Q7',
    ]);
  });

  it('no query selects a per-person column', () => {
    for (const query of LEGACY_EVIDENCE_QUERIES) {
      const select = query.sql.split(/\bFROM\b/u)[0] ?? '';
      expect(select, query.id).not.toMatch(/\b(u\.)?(id|username|number|ref_code)\s*,/u);
    }
  });

  it('bounds every cell', () => {
    expect(boundedCell('a'.repeat(100))).toHaveLength(65);
    expect(boundedCell('x\u0000y')).toBe('x\\x00y');
    expect(boundedCell(null)).toBeNull();
  });
});

describe('cross-checks', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('agree when the evidence matches the decisions, and say so when it does not', async () => {
    const snapshot = await snapshotOf(buildSyntheticLegacyDataset());
    const plan = planLegacyImport({
      snapshot,
      mapping: parsePanelMapping(syntheticMappingFile(TENANT, A, B), TENANT),
      salesCurrency: 'IRT',
      existingCustomers: new Map(),
      existingOpenings: new Map(),
      trialOverrides: new Map(),
      trialDecided: new Set(),
      existingShapes: new Map(),
      tariffCandidates: [],
      inventories: syntheticInventories(A, B),
    });
    // The rows MariaDB returns for the synthetic dataset (recorded by the legacy-mysql suite).
    const evidence: LegacyEvidence = {
      available: true,
      results: [
        { id: 'Q7', title: '', columns: ['COUNT(*)'], rows: [['1']], error: null },
        { id: 'Q6', title: '', columns: ['is_test', 'COUNT(*)'], rows: [['0', '3']], error: null },
        {
          id: 'Q1b',
          title: '',
          columns: ['outcome'],
          rows: [
            ['MAPPABLE'],
            ['MAPPABLE'],
            ['MAPPABLE'],
            ['MAPPABLE'],
            ['MAPPABLE'],
            ['MAPPABLE'],
            ['VOLUME_ZERO'],
          ],
          error: null,
        },
        {
          id: 'Q2b',
          title: '',
          columns: ['decision', 'n'],
          rows: [
            ['INHERIT_NEXA_POLICY', '7'],
            ['LEGACY_LIMIT_UNREADABLE', '1'],
            ['LEGACY_NO_TRIALS', '1'],
            ['LEGACY_TRIAL_CONSUMED', '2'],
          ],
          error: null,
        },
      ],
    };
    const checks = crossCheckEvidence(evidence, snapshot, plan);
    expect(checks.map((c) => [c.id, c.agree])).toEqual([
      ['Q7', true],
      ['Q6', true],
      ['Q1b', true],
      ['Q2b', true],
    ]);
    const wrong = crossCheckEvidence(
      {
        available: true,
        results: [{ id: 'Q7', title: '', columns: ['COUNT(*)'], rows: [['2']], error: null }],
      },
      snapshot,
      plan,
    );
    expect(wrong[0]?.agree).toBe(false);
    expect(wrong[1]?.agree).toBeNull();
    expect(
      crossCheckEvidence(
        { available: false, reason: 'SOURCE_ENGINE_NOT_SQL' },
        snapshot,
        plan,
      ).every((c) => c.agree === null),
    ).toBe(true);
  });
});

describe('the report', () => {
  const report = {
    format: LEGACY_REPORT_FORMAT as typeof LEGACY_REPORT_FORMAT,
    mode: 'AUDIT' as const,
    synthetic: true,
    generatedAt: '2026-10-04T00:00:00.000Z',
    durationMs: 5,
    tenantId: 't',
    codeVersion: '0.0.0-dev',
    sections: { wallet: { sumMinor: 12n, rows: [{ a: 1, b: 2n }] } },
    verdict: 'READY_FOR_DRY_RUN',
  };

  it('renders bigints as strings, and a SYNTHETIC banner first', () => {
    expect(JSON.parse(reportJson(report)).sections.wallet.sumMinor).toBe('12');
    const md = reportMarkdown(report);
    expect(md.split('\n').slice(0, 4).join('\n')).toContain('SYNTHETIC SOURCE — NOT EVIDENCE');
    expect(md).toContain('| sumMinor | 12 |');
    expect(reportMarkdown({ ...report, synthetic: false })).not.toContain('SYNTHETIC');
  });
});

describe('the source DSN', () => {
  it('parses a DSN and labels it without the user or password', () => {
    const options = parseMysqlDsn('mysql://oldbot_ro:pw@db.internal:3307/oldbot');
    expect(options).toMatchObject({
      host: 'db.internal',
      port: 3307,
      user: 'oldbot_ro',
      password: 'pw',
      database: 'oldbot',
    });
    expect(mysqlSourceLabel(options)).toBe('mysql db.internal:3307/oldbot');
    expect(mysqlSourceLabel(options)).not.toMatch(/oldbot_ro|pw/u);
    expect(parseMysqlDsn('mysql://ro@localhost/oldbot?socket=/run/mysqld.sock').socketPath).toBe(
      '/run/mysqld.sock',
    );
    for (const bad of [
      'oldbot',
      'postgres://a@b/c',
      'mysql://db/oldbot',
      'mysql://ro@db/',
      'mysql://ro@db/x?ssl=0',
    ]) {
      expect(() => parseMysqlDsn(bad), bad).toThrow(LegacySourceRefused);
    }
  });
});

describe('the provider read guard', () => {
  it('sends reads and the token exchange; refuses every other request without sending it', async () => {
    const sent: ProviderHttpRequest[] = [];
    const inner: ProviderHttpClient = {
      send: (request) => {
        sent.push(request);
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {},
          bodyText: '{}',
          setCookie: [],
        });
      },
    };
    const counts = { reads: 0, refusedWrites: 0 };
    const guarded = readOnlyGuard(inner, counts);
    await guarded.send({ method: 'GET', effect: 'READ', path: 'api/users?offset=0&limit=5' });
    await guarded.send({
      method: 'POST',
      effect: 'READ',
      path: TOKEN_PATH,
      body: { kind: 'form', value: {} },
    } as ProviderHttpRequest);
    for (const request of [
      { method: 'POST', effect: 'WRITE', path: 'api/user' },
      { method: 'POST', effect: 'READ', path: 'api/user' },
      { method: 'PUT', effect: 'WRITE', path: 'api/user/x' },
      { method: 'DELETE', effect: 'WRITE', path: 'api/user/x' },
      { method: 'POST', effect: 'WRITE', path: TOKEN_PATH },
    ]) {
      const result = await guarded.send(request as unknown as ProviderHttpRequest);
      expect(result.ok).toBe(false);
    }
    expect(counts).toEqual({ reads: 2, refusedWrites: 5 });
    expect(sent.map((r) => r.method)).toEqual(['GET', 'POST']);
  });
});
