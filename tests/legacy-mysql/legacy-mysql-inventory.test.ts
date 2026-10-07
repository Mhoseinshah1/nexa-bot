import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEGACY_TABLE_CLASSIFICATION } from '@nexa/contracts';
import {
  readLegacyInventoryTables,
  takeLegacyInventory,
} from '../../apps/api/src/modules/platform/legacy-importer/application/legacy-inventory';
import {
  defineLegacyReadSet,
  readLegacyReadSet,
  withBoundReadSetSession,
} from '../../apps/api/src/modules/platform/legacy-importer/application/read-set';
import { LegacySourceRefused } from '../../apps/api/src/modules/platform/legacy-importer/application/source-port';
import { readImportV1Identity } from '../../apps/api/src/modules/platform/legacy-importer/application/source-snapshot';
import { FixtureLegacySourceConnector } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/fixture-legacy-source';
import {
  MysqlLegacySourceConnector,
  parseMysqlDsn,
} from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/mysql-legacy-source';
import {
  SYNTHETIC_UNCLASSIFIED_TABLE,
  buildSyntheticLegacyDataset,
  syntheticLegacySql,
} from '../fixtures/legacy/synthetic-legacy';

/**
 * Mirza migration PR1 — the table inventory, the read set framework and the freeze proof
 * on a REAL engine: MariaDB 10.11 and MySQL 8.0 in CI's `legacy-mysql` matrix. Like the
 * source suite beside it, it FAILS without `NEXA_LEGACY_MYSQL_ADMIN_DSN`, never skips.
 * SYNTHETIC data only; NOT EVIDENCE about the legacy archive.
 */

const ADMIN_DSN = process.env['NEXA_LEGACY_MYSQL_ADMIN_DSN'];
const DATABASE = 'nexa_legacy_inventory_t';
const RO = { user: 'nexa_legacy_inv_ro_t', password: 'ro-inventory-synthetic-pw' };
const RW = { user: 'nexa_legacy_inv_rw_t', password: 'rw-inventory-synthetic-pw' };
const CATALOGUE = Object.keys(LEGACY_TABLE_CLASSIFICATION);

let admin: mysql.Connection;
let host: string;
let port: number;

function connector(account: { user: string; password: string }): MysqlLegacySourceConnector {
  return new MysqlLegacySourceConnector({
    host,
    port,
    socketPath: null,
    user: account.user,
    password: account.password,
    database: DATABASE,
  });
}

const fixture = () => new FixtureLegacySourceConnector(buildSyntheticLegacyDataset() as never);

async function reload(): Promise<void> {
  await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
  await admin.query(`CREATE DATABASE \`${DATABASE}\``);
  await admin.query(`USE \`${DATABASE}\``);
  await admin.query(syntheticLegacySql(buildSyntheticLegacyDataset()));
}

async function adminCount(table: string): Promise<number> {
  const [rows] = await admin.query<mysql.RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM \`${DATABASE}\`.\`${table}\``,
  );
  return Number(rows[0]?.['n']);
}

/** The freeze script's statements, one at a time (the session never allows several). */
function freezeStatements(): string[] {
  return readFileSync('scripts/legacy-freeze-checksum.sql', 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('--'))
    .join('\n')
    .split(/;\s*\n/u)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

async function runFreezeScript(account: {
  user: string;
  password: string;
}): Promise<{ table: string; checksum: string }[]> {
  const connection = await mysql.createConnection({
    host,
    port,
    user: account.user,
    password: account.password,
    database: DATABASE,
    multipleStatements: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
  try {
    let last: unknown = null;
    for (const statement of freezeStatements()) {
      const [result] = await connection.query(statement);
      if (statement.startsWith('EXECUTE')) last = result;
    }
    // EXECUTE answers like a stored procedure on some engines: the rows, then a status.
    const rows = (
      Array.isArray(last) && Array.isArray(last[0]) ? last[0] : last
    ) as mysql.RowDataPacket[];
    return rows.map((row) => ({
      table: String(row['Table']),
      checksum: String(row['Checksum']),
    }));
  } finally {
    await connection.end();
  }
}

beforeAll(async () => {
  if (ADMIN_DSN === undefined || ADMIN_DSN === '') {
    throw new Error(
      'NEXA_LEGACY_MYSQL_ADMIN_DSN is not set. This suite needs a disposable MySQL/MariaDB ' +
        'server and FAILS without one; see docs/legacy-migration/importer.md §Tests.',
    );
  }
  const options = parseMysqlDsn(ADMIN_DSN);
  host = options.host ?? '127.0.0.1';
  port = options.port ?? 3306;
  admin = await mysql.createConnection({
    host,
    port,
    user: options.user,
    ...(options.password === null ? {} : { password: options.password }),
    multipleStatements: true,
  });
  await reload();
  for (const account of [RO, RW]) {
    await admin.query(`DROP USER IF EXISTS '${account.user}'@'%'`);
    await admin.query(`CREATE USER '${account.user}'@'%' IDENTIFIED BY '${account.password}'`);
  }
  await admin.query(`GRANT SELECT ON \`${DATABASE}\`.* TO '${RO.user}'@'%'`);
  await admin.query(`GRANT ALL ON \`${DATABASE}\`.* TO '${RW.user}'@'%'`);
}, 120_000);

afterAll(async () => {
  await admin?.end();
});

describe('tables() and the exact counts on the engine', () => {
  it('lists every table of the database, base tables, InnoDB, with the declared charset', async () => {
    const session = await connector(RO).open();
    try {
      const tables = [...(await session.tables())].sort((a, b) => a.name.localeCompare(b.name));
      expect(tables).toEqual(
        ['invoice', 'nexa_synthetic_fixture', SYNTHETIC_UNCLASSIFIED_TABLE, 'product', 'user'].map(
          (name) => ({
            name,
            tableType: 'BASE TABLE',
            storageEngine: 'InnoDB',
            charset: 'utf8mb4',
            collation: 'utf8mb4_bin',
          }),
        ),
      );
      for (const table of tables) {
        expect(await session.countRows(table.name), table.name).toBe(await adminCount(table.name));
      }
    } finally {
      await session.close();
    }
  });

  it('the engine and the in-memory fixture inventory the same dataset identically', async () => {
    const engine = await takeLegacyInventory(connector(RO), null, CATALOGUE);
    const memory = await takeLegacyInventory(fixture(), null, CATALOGUE);
    expect(engine.tables).toEqual(memory.tables);
    expect(engine.fingerprint).toBe(memory.fingerprint);
    expect(engine.importV1.fingerprint).toBe(memory.importV1.fingerprint);
    expect(engine.verdict).toBe('UNCLASSIFIED_TABLES');
    expect(engine.engine).toMatch(/^(MARIADB|MYSQL)$/u);
  });

  it('counts inside the snapshot: a commit after the session opened is not counted', async () => {
    const session = await connector(RO).open();
    try {
      const before = await adminCount(SYNTHETIC_UNCLASSIFIED_TABLE);
      await admin.query(
        `INSERT INTO \`${DATABASE}\`.\`${SYNTHETIC_UNCLASSIFIED_TABLE}\` (\`id\`, \`note\`) VALUES (99, 'late')`,
      );
      await admin.query(
        `INSERT INTO \`${DATABASE}\`.\`user\` (\`id\`, \`Balance\`, \`limit_usertest\`) VALUES ('777777777', '1', '1')`,
      );
      const { tables } = await readLegacyInventoryTables(session);
      expect(tables.find((t) => t.name === SYNTHETIC_UNCLASSIFIED_TABLE)?.rows).toBe(before);
      expect(tables.find((t) => t.name === 'user')?.rows).toBe(11);
    } finally {
      await session.close();
    }
    // A new session sees the commits: the counts were the snapshot's, not stale estimates.
    const fresh = await takeLegacyInventory(connector(RO), null, CATALOGUE);
    expect(fresh.tables.find((t) => t.name === 'user')?.rows).toBe(12);
    await reload();
  });

  it('an inventory through an account that COULD write changes nothing', async () => {
    const before = await runFreezeScript(RO);
    const approved = (await readImportV1Identity(await fixture().open())).fingerprint;
    const inventory = await takeLegacyInventory(connector(RW), approved, CATALOGUE);
    expect(inventory.importV1.bound).toBe(true);
    expect(await runFreezeScript(RO)).toEqual(before);
  });

  it('a different source is refused before any table is counted', async () => {
    await expect(takeLegacyInventory(connector(RO), 'c'.repeat(64), CATALOGUE)).rejects.toThrow(
      /SOURCE_FINGERPRINT_MISMATCH/u,
    );
  });
});

describe('read sets on the engine', () => {
  const PROBE = defineLegacyReadSet({
    name: 'synthetic-probe',
    version: 1,
    tables: [
      { table: 'user', primaryKey: 'id', columns: ['id', 'Balance', 'username'] },
      {
        table: 'product',
        primaryKey: 'id',
        columns: ['id', 'code_product', 'price_product'],
        optionalColumns: ['agent'],
      },
    ],
  });

  it('fingerprint identically to the fixture, bound to the approved v1 source, in one session', async () => {
    const approved = (await readImportV1Identity(await fixture().open())).fingerprint;
    const fromEngine = await withBoundReadSetSession(connector(RO), approved, (session) =>
      readLegacyReadSet(session, PROBE, { batchSize: 3 }),
    );
    const fromMemory = await readLegacyReadSet(await fixture().open(), PROBE);
    expect(fromEngine.tables).toEqual(fromMemory.tables);
    expect(fromEngine.schemaHash).toBe(fromMemory.schemaHash);
    expect(fromEngine.fingerprint).toBe(fromMemory.fingerprint);
  });

  it('the engine adapter refuses rows of an UNCLASSIFIED table', async () => {
    const session = await connector(RW).open();
    try {
      const rows = session.readSetRows(SYNTHETIC_UNCLASSIFIED_TABLE, 'id', ['id', 'note']);
      await expect(
        (async () => {
          for await (const row of rows) void row;
        })(),
      ).rejects.toBeInstanceOf(LegacySourceRefused);
    } finally {
      await session.close();
    }
  });
});

describe('the freeze proof script', () => {
  it('checksums EVERY base table — the ones no read set reads included — read-only', async () => {
    const proof = await runFreezeScript(RO);
    expect(proof.map((p) => p.table)).toEqual(
      ['invoice', 'nexa_synthetic_fixture', SYNTHETIC_UNCLASSIFIED_TABLE, 'product', 'user'].map(
        (t) => `${DATABASE}.${t}`,
      ),
    );
    for (const p of proof) expect(p.checksum, p.table).toMatch(/^[0-9]+$/u);
    const inventory = await takeLegacyInventory(connector(RO), null, CATALOGUE);
    expect(inventory.freezeChecksum).toBe(
      `CHECKSUM TABLE ${proof.map((p) => `\`${p.table.split('.')[1] ?? ''}\``).join(', ')};`,
    );
  });

  it('notices a write to a table outside user and invoice', async () => {
    const before = await runFreezeScript(RO);
    await admin.query(
      `UPDATE \`${DATABASE}\`.\`product\` SET \`price_product\` = '1' WHERE \`id\` = 1`,
    );
    await admin.query(
      `UPDATE \`${DATABASE}\`.\`${SYNTHETIC_UNCLASSIFIED_TABLE}\` SET \`note\` = 'x' WHERE \`id\` = 2`,
    );
    try {
      const after = await runFreezeScript(RO);
      const changed = after
        .filter((p, i) => p.checksum !== before[i]?.checksum)
        .map((p) => p.table.split('.')[1]);
      expect(changed).toEqual([SYNTHETIC_UNCLASSIFIED_TABLE, 'product']);
    } finally {
      await reload();
    }
  });
});
