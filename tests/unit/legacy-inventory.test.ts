import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LEGACY_TABLE_CLASSIFICATION, systemJobActor, type CorrelationId } from '@nexa/contracts';
import {
  InventoryUsageError,
  inventoryExitCode,
  parseInventoryArgs,
  runInventory,
} from '../../apps/api/src/legacy-import-inventory';
import {
  INVENTORY_FINGERPRINT_VERSION,
  freezeCovers,
  inventoryJson,
  inventoryMarkdown,
  takeLegacyInventory,
} from '../../apps/api/src/modules/platform/legacy-importer/application/legacy-inventory';
import {
  IMPORT_READ_SET_V1,
  type LegacySourceConnector,
  type LegacySourceSession,
  type LegacyTableInfo,
} from '../../apps/api/src/modules/platform/legacy-importer/application/source-port';
import { readImportV1Identity } from '../../apps/api/src/modules/platform/legacy-importer/application/source-snapshot';
import { FixtureLegacySourceConnector } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/fixture-legacy-source';
import {
  SYNTHETIC_UNCLASSIFIED_TABLE,
  buildSyntheticLegacyDataset,
  type SyntheticLegacyDataset,
} from '../fixtures/legacy/synthetic-legacy';

/**
 * Mirza migration PR1 — `legacy-import inventory` over the SYNTHETIC fixture
 * (`legacy-inventory.ts`, `legacy-import-inventory.ts`). The engine side (exact counts in
 * the snapshot, charsets as MySQL 8 and MariaDB report them) is `tests/legacy-mysql`.
 */

const CATALOGUE = Object.keys(LEGACY_TABLE_CLASSIFICATION);

/** The pinned `legacy-read-set:inventory:v1` of the synthetic fixture (synthetic only). */
const SYNTHETIC_INVENTORY_FINGERPRINT =
  '29561d2885c0d6a4c621d45412f6bf113f13c6587fd27045dbb89de5c0c852da';

function withoutUnclassified(): SyntheticLegacyDataset {
  const dataset = buildSyntheticLegacyDataset();
  const { [SYNTHETIC_UNCLASSIFIED_TABLE]: _dropped, ...tables } = dataset.tables;
  return {
    ...dataset,
    schema: dataset.schema.filter((c) => c.table !== SYNTHETIC_UNCLASSIFIED_TABLE),
    tables: tables as SyntheticLegacyDataset['tables'],
  };
}

function connectorOf(dataset: SyntheticLegacyDataset = buildSyntheticLegacyDataset()) {
  return new FixtureLegacySourceConnector(dataset as never);
}

async function v1Of(dataset?: SyntheticLegacyDataset): Promise<string> {
  return (await readImportV1Identity(await connectorOf(dataset).open())).fingerprint;
}

/** A connector whose sessions are the fixture's, rewritten by `edit`, with a count spy. */
function edited(
  dataset: SyntheticLegacyDataset,
  edit: (session: LegacySourceSession) => Partial<LegacySourceSession>,
) {
  const counted = vi.fn();
  const connector: LegacySourceConnector = {
    label: 'edited',
    open: async () => {
      const session = await connectorOf(dataset).open();
      const replaced = { ...session, ...edit(session) };
      return {
        ...replaced,
        countRows: (table: string) => {
          counted(table);
          return replaced.countRows(table);
        },
      };
    },
  };
  return { connector, counted };
}

describe('the inventory of the synthetic source', () => {
  it('lists every table in name byte order, classified, exactly counted, value-free', async () => {
    const dataset = buildSyntheticLegacyDataset();
    const inventory = await takeLegacyInventory(connectorOf(dataset), await v1Of(), CATALOGUE);
    expect(inventory.fingerprintVersion).toBe('legacy-read-set:inventory:v1');
    expect(INVENTORY_FINGERPRINT_VERSION).toBe(inventory.fingerprintVersion);
    expect(inventory.tables.map((t) => [t.name, t.class, t.columns, t.rows, t.findings])).toEqual([
      ['invoice', 'SUPPORTED', 15, 21, []],
      ['nexa_synthetic_fixture', 'SUPPORTED', 1, 1, []],
      [SYNTHETIC_UNCLASSIFIED_TABLE, 'UNCLASSIFIED', 2, 3, ['UNCLASSIFIED']],
      ['product', 'SUPPORTED', 7, 2, []],
      ['user', 'SUPPORTED', 8, 11, []],
    ]);
    for (const table of inventory.tables) {
      expect(table).toMatchObject({
        tableType: 'BASE TABLE',
        storageEngine: 'InnoDB',
        charset: 'utf8mb4',
        collation: 'utf8mb4_bin',
        columnCharsets: ['utf8mb4'],
      });
      expect(table.columnsHash).toMatch(/^[0-9a-f]{64}$/u);
    }
    expect(inventory.totals).toEqual({
      tables: 5,
      rows: 38,
      byClass: { SUPPORTED: 4, ARCHIVE: 0, SECRETS_MANUAL: 0, OWNER_DECISION: 0, UNCLASSIFIED: 1 },
    });
    expect(inventory.classifiedAbsent).toEqual([]);
    expect(inventory.synthetic).toBe(true);
  });

  it('pins the synthetic inventory fingerprint', async () => {
    const inventory = await takeLegacyInventory(connectorOf(), null, CATALOGUE);
    expect(inventory.fingerprint).toBe(SYNTHETIC_INVENTORY_FINGERPRINT);
  });

  it('fails closed on an UNCLASSIFIED table, bound or not', async () => {
    const bound = await takeLegacyInventory(connectorOf(), await v1Of(), CATALOGUE);
    expect(bound.importV1.bound).toBe(true);
    expect(bound.verdict).toBe('UNCLASSIFIED_TABLES');
    expect(inventoryExitCode(bound)).toBe(3);
    const unbound = await takeLegacyInventory(connectorOf(), null, CATALOGUE);
    expect(unbound.verdict).toBe('UNCLASSIFIED_TABLES');
  });

  it('is COMPLETE only when every table is classified AND the source is the approved one', async () => {
    const dataset = withoutUnclassified();
    const unbound = await takeLegacyInventory(connectorOf(dataset), null, CATALOGUE);
    expect(unbound.verdict).toBe('FINGERPRINT_UNBOUND');
    expect(unbound.importV1).toMatchObject({ expected: null, bound: false });
    expect(inventoryExitCode(unbound)).toBe(3);
    const bound = await takeLegacyInventory(connectorOf(dataset), await v1Of(dataset), CATALOGUE);
    expect(bound.verdict).toBe('COMPLETE');
    expect(inventoryExitCode(bound)).toBe(0);
  });

  it('refuses another source before counting a single table', async () => {
    const { connector, counted } = edited(buildSyntheticLegacyDataset(), () => ({}));
    await expect(takeLegacyInventory(connector, 'f'.repeat(64), CATALOGUE)).rejects.toThrow(
      /SOURCE_FINGERPRINT_MISMATCH/u,
    );
    expect(counted).not.toHaveBeenCalled();
  });

  it('prints no row value in either format', async () => {
    const dataset = buildSyntheticLegacyDataset();
    const inventory = await takeLegacyInventory(connectorOf(dataset), null, CATALOGUE);
    const text = inventoryJson(inventory) + inventoryMarkdown(inventory);
    const values = new Set<string>();
    for (const rows of Object.values(dataset.tables)) {
      for (const row of rows) {
        for (const value of Object.values(row)) {
          // Plain lowercase words (`none`, `active`, `synthetic`) are also report vocabulary.
          if (value !== null && value.length >= 4 && !/^[a-z]+$/u.test(value)) values.add(value);
        }
      }
    }
    expect(values.size).toBeGreaterThan(20);
    for (const value of values) expect(text, value).not.toContain(value);
  });
});

describe('what the inventory fingerprint covers', () => {
  async function fingerprintOf(
    dataset: SyntheticLegacyDataset,
    edit: (session: LegacySourceSession) => Partial<LegacySourceSession> = () => ({}),
  ) {
    return (await takeLegacyInventory(edited(dataset, edit).connector, null, CATALOGUE))
      .fingerprint;
  }

  it('changes with a count, a column, a type, a charset; never with a row value', async () => {
    const dataset = buildSyntheticLegacyDataset();
    const base = await fingerprintOf(dataset);
    expect(await fingerprintOf(buildSyntheticLegacyDataset({ extraUsers: 1 }))).not.toBe(base);
    expect(
      await fingerprintOf({
        ...dataset,
        schema: dataset.schema.map((c) =>
          c.table === SYNTHETIC_UNCLASSIFIED_TABLE && c.column === 'note'
            ? { ...c, dataType: 'text' }
            : c,
        ),
      }),
    ).not.toBe(base);
    expect(
      await fingerprintOf({
        ...dataset,
        schema: [
          ...dataset.schema,
          { table: 'user', column: 'affiliates2', dataType: 'varchar', ordinal: 99 },
        ],
      }),
    ).not.toBe(base);
    expect(await fingerprintOf({ ...dataset, tableCollation: 'utf8mb4_general_ci' })).not.toBe(
      base,
    );
    const valueChanged = {
      ...dataset,
      tables: {
        ...dataset.tables,
        user: dataset.tables.user.map((r, i) => (i === 0 ? { ...r, Balance: '1' } : r)),
      },
    };
    expect(await fingerprintOf(valueChanged)).toBe(base);
  });
});

describe('blockers and warnings', () => {
  const extraTable = (info: Partial<LegacyTableInfo> & { name: string }) =>
    edited(buildSyntheticLegacyDataset(), (session) => ({
      tables: async () => [
        ...(await session.tables()),
        {
          tableType: 'BASE TABLE',
          storageEngine: 'InnoDB',
          charset: 'utf8mb4',
          collation: 'utf8mb4_bin',
          ...info,
        },
      ],
      countRows: (table: string) =>
        table === info.name ? Promise.resolve(0) : session.countRows(table),
    }));

  it('a view is BLOCKED and never counted', async () => {
    const { connector, counted } = extraTable({ name: 'v_report', tableType: 'VIEW' });
    const inventory = await takeLegacyInventory(connector, null, CATALOGUE);
    expect(inventory.verdict).toBe('BLOCKED');
    expect(inventory.tables.find((t) => t.name === 'v_report')).toMatchObject({
      rows: null,
      findings: ['NOT_A_BASE_TABLE', 'UNCLASSIFIED'],
    });
    expect(counted).not.toHaveBeenCalledWith('v_report');
    expect(inventory.freezeChecksum).not.toContain('v_report');
  });

  it('a name no statement may carry is BLOCKED, never counted, and stops the freeze statement', async () => {
    const { connector, counted } = extraTable({ name: 'odd|name`' });
    const inventory = await takeLegacyInventory(connector, null, CATALOGUE);
    expect(inventory.verdict).toBe('BLOCKED');
    expect(counted).not.toHaveBeenCalledWith('odd|name`');
    expect(inventory.freezeChecksum).toBeNull();
    // Printed inert: a pipe or a backtick in a source name cannot reshape the report.
    expect(inventoryMarkdown(inventory)).toContain('| odd?name? |');
  });

  it('a non-InnoDB or non-utf8mb4 table is reported, not hidden', async () => {
    const { connector } = extraTable({
      name: 'old_log',
      storageEngine: 'MyISAM',
      charset: 'latin1',
    });
    const inventory = await takeLegacyInventory(connector, null, CATALOGUE);
    expect(inventory.tables.find((t) => t.name === 'old_log')?.findings).toEqual([
      'UNCLASSIFIED',
      'NOT_SNAPSHOT_CONSISTENT',
      'NOT_UTF8MB4',
    ]);
  });

  it('names a catalogue table the source does not have', async () => {
    const dataset = buildSyntheticLegacyDataset();
    const unmarked = edited(dataset, (session) => ({
      tables: async () =>
        (await session.tables()).filter((t) => t.name !== 'nexa_synthetic_fixture'),
    }));
    const inventory = await takeLegacyInventory(unmarked.connector, null, CATALOGUE);
    expect(inventory.classifiedAbsent).toEqual(['nexa_synthetic_fixture']);
  });
});

describe('the freeze proof covers every table of every read set', () => {
  it('is CHECKSUM TABLE over every base table, the v1 tables among them', async () => {
    const inventory = await takeLegacyInventory(connectorOf(), null, CATALOGUE);
    expect(inventory.freezeChecksum).toBe(
      'CHECKSUM TABLE `invoice`, `nexa_synthetic_fixture`, `nexa_synthetic_unclassified`, `product`, `user`;',
    );
    expect(freezeCovers(inventory, IMPORT_READ_SET_V1.tables)).toBe(true);
    expect(freezeCovers(inventory, ['setting'])).toBe(false);
  });
});

describe('legacy-import inventory: arguments', () => {
  const base = ['--tenant', 'primary', '--source', 'fixture:x.json', '--target', 'nexa_dev'];

  it('parses the minimal form with no default for anything that decides', () => {
    expect(parseInventoryArgs(base)).toEqual({
      tenant: 'primary',
      source: 'fixture:x.json',
      sourcePasswordEnv: null,
      target: 'nexa_dev',
      expectedFingerprint: null,
      format: 'md',
      allowProductionTarget: false,
    });
  });

  it('refuses a password anywhere, a missing flag, a malformed fingerprint and import-only flags', () => {
    for (const argv of [
      [...base, '--password', 'x'],
      ['--tenant', 'primary', '--source', 'mysql://u:pw@h/db', '--target', 'nexa_dev'],
      ['--tenant', 'primary', '--target', 'nexa_dev'],
      ['--source', 'fixture:x', '--target', 'nexa_dev'],
      [...base, '--expected-fingerprint', 'ABC'],
      [...base, '--panel-map', 'map.json'],
      [...base, '--out', '/tmp'],
      [...base, '--format', 'html'],
      [...base, '--tenant', 'twice'],
      [...base, '--mode', 'import'],
    ]) {
      expect(() => parseInventoryArgs(argv), argv.join(' ')).toThrow(InventoryUsageError);
    }
  });
});

describe('legacy-import inventory: what it writes', () => {
  const scope = { tenantId: '11111111-1111-4111-8111-111111111111' as never, botInstanceId: null };
  const actor = systemJobActor('legacy-import:inventory', 'corr-inv' as CorrelationId);

  function importer() {
    return {
      recordReadSetRun: vi.fn(async (_s: unknown, _a: unknown, run: Record<string, unknown>) => ({
        run: { ...run, id: 'r1', codeVersion: null, recordedAt: new Date(0) } as never,
        created: true,
      })),
    };
  }

  it('writes nothing when it is not bound to an approved source', async () => {
    const fake = importer();
    const outcome = await runInventory(
      fake,
      connectorOf(),
      { expectedFingerprint: null },
      { scope, actor, productionLikeTarget: false },
    );
    expect(outcome.recorded).toBeNull();
    expect(fake.recordReadSetRun).not.toHaveBeenCalled();
  });

  it('records the inventory fingerprint and the v1 source fingerprint when bound', async () => {
    const fake = importer();
    const approved = await v1Of();
    const outcome = await runInventory(
      fake,
      connectorOf(),
      { expectedFingerprint: approved },
      { scope, actor, productionLikeTarget: false },
    );
    expect(fake.recordReadSetRun).toHaveBeenCalledTimes(1);
    expect(fake.recordReadSetRun.mock.calls[0]?.[2]).toEqual({
      readSet: 'inventory',
      readSetVersion: 1,
      fingerprintVersion: 'legacy-read-set:inventory:v1',
      readSetFingerprint: outcome.inventory.fingerprint,
      sourceFingerprint: approved,
      sourceSchemaHash: outcome.inventory.importV1.schemaHash,
      sourceEngine: 'SYNTHETIC_FIXTURE',
      synthetic: true,
      tableCount: 5,
      rowCount: 38n,
    });
  });

  it('never records a SYNTHETIC source against a production-like target, nor a mismatch', async () => {
    const fake = importer();
    await expect(
      runInventory(
        fake,
        connectorOf(),
        { expectedFingerprint: await v1Of() },
        { scope, actor, productionLikeTarget: true },
      ),
    ).rejects.toThrow(InventoryUsageError);
    await expect(
      runInventory(
        fake,
        connectorOf(),
        { expectedFingerprint: 'e'.repeat(64) },
        { scope, actor, productionLikeTarget: false },
      ),
    ).rejects.toThrow(/SOURCE_FINGERPRINT_MISMATCH/u);
    expect(fake.recordReadSetRun).not.toHaveBeenCalled();
  });
});

describe('scripts/legacy-freeze-checksum.sql (the runbook freeze proof)', () => {
  const statements = readFileSync('scripts/legacy-freeze-checksum.sql', 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('--'))
    .join('\n')
    .split(/;\s*\n/u)
    .map((s) => s.replace(/\s+/gu, ' ').trim())
    .filter((s) => s !== '');

  it('is read-only: session settings, information_schema reads, CHECKSUM TABLE', () => {
    expect(statements.map((s) => s.split(' ').slice(0, 2).join(' '))).toEqual([
      'SET SESSION',
      'SET SESSION',
      "SELECT CONCAT('CHECKSUM",
      'SELECT COUNT(*)',
      'PREPARE nexa_freeze_checksum',
      'EXECUTE nexa_freeze_checksum',
      'DEALLOCATE PREPARE',
    ]);
    for (const s of statements) {
      expect(s, s).not.toMatch(
        /\b(INSERT|UPDATE|DELETE|REPLACE\s+INTO|DROP|CREATE|ALTER|TRUNCATE|GRANT|LOCK|RENAME|GLOBAL)\b/iu,
      );
    }
  });

  it('covers every base table of the database: no table filter beyond the schema', () => {
    const select = statements[2] ?? '';
    expect(select).toContain("WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'");
    expect(select).not.toMatch(/TABLE_NAME\s*(=|IN|LIKE|<>|NOT)/iu);
    expect(select).toContain('ORDER BY CAST(TABLE_NAME AS BINARY)');
    // The count the checker holds the checksum lines to: the same tables, no filter.
    expect(statements[3]).toBe(
      "SELECT COUNT(*) AS base_tables FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'",
    );
  });
});

describe('scripts/legacy-freeze-checksum-verify.sh (no file is a freeze proof by itself)', () => {
  const GOOD =
    'base_tables\n3\nTable\tChecksum\noldbot.invoice\t11\noldbot.product\t0\noldbot.user\t42\n';

  function verify(...contents: (string | null)[]): { status: number | null; out: string } {
    const dir = mkdtempSync(join(tmpdir(), 'nexa-freeze-'));
    try {
      const files = contents.map((content, i) => {
        const file = join(dir, `run-${String(i)}.tsv`);
        if (content !== null) writeFileSync(file, content);
        return file;
      });
      const run = spawnSync('bash', ['scripts/legacy-freeze-checksum-verify.sh', ...files], {
        encoding: 'utf8',
      });
      return { status: run.status, out: `${run.stdout}${run.stderr}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('accepts a well-formed run, and two equal runs under different database names', () => {
    expect(verify(GOOD)).toMatchObject({ status: 0 });
    const restored = GOOD.replaceAll('oldbot.', 'restored.');
    const both = verify(GOOD, restored);
    expect(both.status).toBe(0);
    expect(both.out).toContain('EQUAL');
  });

  it('refuses what a failed client leaves behind, so two failures never compare equal', () => {
    const failed: [string, string | null][] = [
      ['missing file', null],
      ['empty file', ''],
      ['count only', 'base_tables\n3\n'],
      ['header only', 'base_tables\n3\nTable\tChecksum\n'],
      ['one table short', GOOD.replace('oldbot.user\t42\n', '')],
      ['NULL checksum', GOOD.replace('oldbot.user\t42', 'oldbot.user\tNULL')],
      ['table twice', GOOD.replace('oldbot.product\t0', 'oldbot.invoice\t0')],
      ['no count', GOOD.replace('base_tables\n3\n', '')],
      ['zero tables', 'base_tables\n0\nTable\tChecksum\n'],
      ['an error line', `${GOOD}ERROR 1142 (42000): SELECT command denied\n`],
    ];
    for (const [why, content] of failed) {
      expect(verify(content).status, why).toBe(1);
      expect(verify(content, content).status, `${why}, compared with itself`).toBe(1);
      expect(verify(GOOD, content).status, `${why}, as the restored copy`).toBe(1);
    }
  });

  it('refuses two well-formed runs that differ, naming the table and no value', () => {
    const changed = verify(GOOD, GOOD.replace('oldbot.user\t42', 'oldbot.user\t43'));
    expect(changed.status).toBe(1);
    expect(changed.out).toMatch(/DIFFERENT[\s\S]*\buser\b/u);
    expect(changed.out).not.toContain('43');
    expect(verify(GOOD, GOOD.replace('oldbot.product', 'oldbot.products')).status).toBe(1);
  });

  it("the runbooks capture the client's own exit status and compare only through it", () => {
    const blocks = [
      readFileSync('docs/legacy-migration/cutover-runbook.md', 'utf8'),
      readFileSync('docs/legacy-migration/rollback-runbook.md', 'utf8'),
    ].flatMap((doc) =>
      doc
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.includes('legacy-freeze-checksum')),
    );
    const runs = blocks.filter((line) => /legacy-freeze-checksum\.sql \| tee /u.test(line));
    // Step 7, step 9, R5: every run of the script records the client's status, not tee's.
    expect(runs).toHaveLength(3);
    for (const line of runs) expect(line, line).toContain('echo "exit ${PIPESTATUS[0]}"');
    const checks = blocks.filter((line) => line.startsWith('bash ') && line.includes('-verify.sh'));
    // Step 7 checks its own file; step 9 and R5 compare against step 7's through the checker.
    expect(checks.map((line) => /-verify\.sh ([^;]*);/u.exec(line)?.[1]?.split(' '))).toEqual([
      ['freeze-checksum-step7.tsv'],
      ['freeze-checksum-step7.tsv', 'freeze-checksum-step9.tsv'],
      ['freeze-checksum-step7.tsv', 'freeze-checksum-R5.tsv'],
    ]);
    for (const line of checks) expect(line, line).toContain('echo "verify exit $?"');
    for (const doc of ['cutover-runbook.md', 'rollback-runbook.md']) {
      const text = readFileSync(`docs/legacy-migration/${doc}`, 'utf8');
      expect(text, doc).not.toMatch(/^\s*diff freeze-checksum/mu);
    }
  });
});
