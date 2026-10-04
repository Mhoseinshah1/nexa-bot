import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  crossCheckEvidence,
  runLegacyEvidence,
} from '../../apps/api/src/modules/platform/legacy-importer/application/evidence-runner';
import { parsePanelMapping } from '../../apps/api/src/modules/platform/legacy-importer/application/panel-mapping';
import { planLegacyImport } from '../../apps/api/src/modules/platform/legacy-importer/application/plan';
import { LegacySourceRefused } from '../../apps/api/src/modules/platform/legacy-importer/application/source-port';
import {
  readFromSession,
  readLegacySnapshot,
} from '../../apps/api/src/modules/platform/legacy-importer/application/source-snapshot';
import { FixtureLegacySourceConnector } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/fixture-legacy-source';
import {
  MysqlLegacySourceConnector,
  parseMysqlDsn,
} from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/mysql-legacy-source';
import {
  buildSyntheticLegacyDataset,
  syntheticLegacySql,
} from '../fixtures/legacy/synthetic-legacy';
import { syntheticInventories, syntheticMappingFile } from '../fixtures/legacy/synthetic-support';

/**
 * Migration P7 — the legacy source on a REAL MySQL-family engine (MariaDB 10.11 in CI and
 * locally). `pnpm test:legacy-mysql`; the CI job `legacy-mysql` runs it against a MariaDB
 * service container. Without `NEXA_LEGACY_MYSQL_ADMIN_DSN` it FAILS, never skips — a
 * suite that skips where it cannot run reports the same green as one that checked.
 *
 * The admin DSN only sets the stage: it creates a scratch database, loads the SYNTHETIC
 * dataset, and creates two accounts — `SELECT`-only, and one with every privilege on the
 * scratch database, which is how the READ ONLY transaction is shown to refuse a write the
 * grant would have allowed. NOT EVIDENCE about the legacy archive.
 */

const ADMIN_DSN = process.env['NEXA_LEGACY_MYSQL_ADMIN_DSN'];
const DATABASE = 'nexa_legacy_synth_test';
const RO = { user: 'nexa_legacy_ro_t', password: 'ro-synthetic-pw' };
const RW = { user: 'nexa_legacy_rw_t', password: 'rw-synthetic-pw' };
const TENANT = '11111111-1111-4111-8111-111111111111';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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

async function fixtureSnapshot() {
  const fixture = new FixtureLegacySourceConnector(buildSyntheticLegacyDataset() as never);
  return readFromSession(fixture.label, await fixture.open());
}

async function rowCount(table: string): Promise<number> {
  const [rows] = await admin.query<mysql.RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM \`${DATABASE}\`.\`${table}\``,
  );
  return Number(rows[0]?.['n']);
}

async function reload(): Promise<void> {
  await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
  await admin.query(`CREATE DATABASE \`${DATABASE}\``);
  await admin.query(`USE \`${DATABASE}\``);
  await admin.query(syntheticLegacySql(buildSyntheticLegacyDataset()));
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
  await admin.query('CREATE DATABASE IF NOT EXISTS `nexa_legacy_empty_t`');
  await admin.query(`GRANT ALL ON \`nexa_legacy_empty_t\`.* TO '${RW.user}'@'%'`);
}, 120_000);

afterAll(async () => {
  await admin?.end();
});

describe('read only', () => {
  it('every session proves a write is refused before it reads a row', async () => {
    for (const [account, code] of [
      [RW, 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION'],
      [RO, undefined],
    ] as const) {
      const session = await connector(account).open();
      try {
        expect(session.descriptor.readOnlyProof.kind).toBe('WRITE_REFUSED');
        if (code !== undefined) expect(session.descriptor.readOnlyProof).toMatchObject({ code });
        expect(session.descriptor.engine).toMatch(/^(MARIADB|MYSQL)$/u);
      } finally {
        await session.close();
      }
    }
  });

  it('a write through the session is refused even with a grant that allows it, and changes nothing', async () => {
    const before = await Promise.all([rowCount('user'), rowCount('invoice')]);
    const session = await connector(RW).open();
    try {
      for (const statement of [
        "INSERT INTO `user` (`id`, `Balance`, `limit_usertest`) VALUES ('555', '1', '1')",
        "UPDATE `user` SET `Balance` = '0'",
        'DELETE FROM `invoice`',
      ]) {
        await expect(session.aggregate(statement)).rejects.toMatchObject({
          code: 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION',
        });
      }
      // And no second statement can ride along with one.
      await expect(session.aggregate('SELECT 1; SELECT 2')).rejects.toBeTruthy();
    } finally {
      await session.close();
    }
    expect(await Promise.all([rowCount('user'), rowCount('invoice')])).toEqual(before);
  });

  it('a database without the legacy tables is refused before any row is read', async () => {
    // MariaDB refuses the probe for being a write before it looks for the table, so the
    // session opens READ ONLY; the schema check then refuses it, whole, before a row.
    const missing = new MysqlLegacySourceConnector({
      host,
      port,
      socketPath: null,
      user: RW.user,
      password: RW.password,
      database: 'nexa_legacy_empty_t',
    });
    await expect(readLegacySnapshot(missing)).rejects.toBeInstanceOf(LegacySourceRefused);
    await expect(readLegacySnapshot(missing)).rejects.toThrow(/SOURCE_SCHEMA_MISSING_TABLE/u);
  });
});

describe('the fingerprint and the snapshot', () => {
  it('MariaDB and the in-memory fixture fingerprint the same dataset identically', async () => {
    const fromEngine = await readLegacySnapshot(connector(RO));
    const fromFixture = await fixtureSnapshot();
    expect(fromEngine.schemaHash).toBe(fromFixture.schemaHash);
    expect(fromEngine.tables).toEqual(fromFixture.tables);
    expect(fromEngine.fingerprint).toBe(fromFixture.fingerprint);
    expect(fromEngine.users.map((u) => u.checksum)).toEqual(
      fromFixture.users.map((u) => u.checksum),
    );
  });

  it('one session reads one snapshot, whatever commits meanwhile', async () => {
    const expected = (await fixtureSnapshot()).fingerprint;
    const session = await connector(RO).open();
    try {
      await admin.query(
        `INSERT INTO \`${DATABASE}\`.\`user\` (\`id\`, \`Balance\`, \`limit_usertest\`) VALUES ('888888888', '5', '1')`,
      );
      await admin.query(`DELETE FROM \`${DATABASE}\`.\`invoice\` WHERE \`id_invoice\` = 'inv0001'`);
      const snapshot = await readFromSession('consistent', session);
      expect(snapshot.fingerprint).toBe(expected);
    } finally {
      await session.close();
      await reload();
    }
  });

  it('a new session after a change fingerprints differently', async () => {
    const before = (await readLegacySnapshot(connector(RO))).fingerprint;
    await admin.query(
      `UPDATE \`${DATABASE}\`.\`user\` SET \`Balance\` = '1' WHERE \`id\` = '100000001'`,
    );
    try {
      expect((await readLegacySnapshot(connector(RO))).fingerprint).not.toBe(before);
    } finally {
      await reload();
    }
  });
});

describe('the SQL evidence runner (Item 1)', () => {
  it('runs every runbook query on the engine, aggregate rows only, and the cross-checks agree', async () => {
    const session = await connector(RO).open();
    let evidence;
    let snapshot;
    try {
      evidence = await runLegacyEvidence(session);
      snapshot = await readFromSession('evidence', session);
    } finally {
      await session.close();
    }
    if (!evidence.available) throw new Error('evidence unavailable on a SQL engine');
    expect(evidence.results.filter((r) => r.error !== null)).toEqual([]);
    expect(evidence.results).toHaveLength(11);
    for (const result of evidence.results) {
      expect(result.columns.join(), result.id).not.toMatch(
        /(^|,)(id|id_user|username|number|Balance)(,|$)/u,
      );
    }
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
    const checks = crossCheckEvidence(evidence, snapshot, plan);
    expect(checks.map((c) => [c.id, c.agree])).toEqual([
      ['Q7', true],
      ['Q6', true],
      ['Q1b', true],
      ['Q2b', true],
    ]);
  });
});
