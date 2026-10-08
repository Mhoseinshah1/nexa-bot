import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  INVOICE_ARCHIVE_EXCLUDED_COLUMNS,
  digestInvoiceArchiveReadSet,
  readApprovedInvoiceArchiveReadSet,
} from '../../apps/api/src/modules/platform/legacy-importer/application/invoice-archive-read-set';
import {
  withBoundReadSetSession,
  type LegacyReadSetBatch,
} from '../../apps/api/src/modules/platform/legacy-importer/application/read-set';
import type { LegacySourceSession } from '../../apps/api/src/modules/platform/legacy-importer/application/source-port';
import { readImportV1Identity } from '../../apps/api/src/modules/platform/legacy-importer/application/source-snapshot';
import { FixtureLegacySourceConnector } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/fixture-legacy-source';
import {
  MysqlLegacySourceConnector,
  parseMysqlDsn,
} from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/mysql-legacy-source';
import {
  SYNTHETIC_ARCHIVE_SECRETS,
  buildSyntheticLegacyDataset,
  syntheticLegacySql,
} from '../fixtures/legacy/synthetic-legacy';

/**
 * Mirza migration PR3 — the `invoice-archive` read set on a REAL engine (CI's `legacy-mysql`
 * matrix: MariaDB 10.11 and MySQL 8.0). FAILS without `NEXA_LEGACY_MYSQL_ADMIN_DSN`, never
 * skips. SYNTHETIC data only (the archive variant, with its odd key shapes — a slash, a
 * Persian id, a padded id — and the three secret-bearing columns); NOT EVIDENCE.
 */

const ADMIN_DSN = process.env['NEXA_LEGACY_MYSQL_ADMIN_DSN'];
const DATABASE = 'nexa_legacy_invoices_t';
const RO = { user: 'nexa_legacy_inv_ro_t', password: 'ro-invoices-synthetic-pw' };

let admin: mysql.Connection;
let host: string;
let port: number;

const engine = () =>
  new MysqlLegacySourceConnector({
    host,
    port,
    socketPath: null,
    user: RO.user,
    password: RO.password,
    database: DATABASE,
  });
const fixture = () =>
  new FixtureLegacySourceConnector(buildSyntheticLegacyDataset({ invoiceArchive: 'A' }) as never);

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
    charset: 'utf8mb4',
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
  await admin.query(`CREATE DATABASE \`${DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
  await admin.query(`USE \`${DATABASE}\``);
  await admin.query(syntheticLegacySql(buildSyntheticLegacyDataset({ invoiceArchive: 'A' })));
  await admin.query(`DROP USER IF EXISTS '${RO.user}'@'%'`);
  await admin.query(`CREATE USER '${RO.user}'@'%' IDENTIFIED BY '${RO.password}'`);
  await admin.query(`GRANT SELECT ON \`${DATABASE}\`.* TO '${RO.user}'@'%'`);
}, 120_000);

afterAll(async () => {
  await admin?.end();
});

/** Every delivered batch, flattened: table, columns and rows in delivery order. */
async function deliver(session: LegacySourceSession, approved: string, batchSize: number) {
  const batches: LegacyReadSetBatch[] = [];
  await readApprovedInvoiceArchiveReadSet(session, approved, {
    batchSize,
    onBatch: (batch) => {
      batches.push(batch);
    },
  });
  return batches.flatMap((batch) =>
    batch.rows.map((row) => ({ table: batch.table, columns: batch.columns, row })),
  );
}

describe('the invoice-archive read set on the engine', () => {
  it('fingerprints exactly as the fixture does (byte order of odd keys included), v1 unmoved', async () => {
    const expected = await digestInvoiceArchiveReadSet(await fixture().open());
    const v1 = (await readImportV1Identity(await fixture().open())).fingerprint;
    const read = await withBoundReadSetSession(engine(), v1, async (session) => {
      const archive = await digestInvoiceArchiveReadSet(session);
      const after = await readImportV1Identity(session);
      return { archive, after };
    });
    expect(read.archive.fingerprint).toBe(expected.fingerprint);
    expect(read.archive.tables).toEqual(expected.tables);
    expect(read.after.fingerprint).toBe(v1);
  });

  it('delivers under the approval exactly the fixture rows, never a secret column', async () => {
    const v1 = (await readImportV1Identity(await fixture().open())).fingerprint;
    const approved = (await digestInvoiceArchiveReadSet(await fixture().open())).fingerprint;
    const onEngine = await withBoundReadSetSession(engine(), v1, (session) =>
      deliver(session, approved, 3),
    );
    const onFixture = await deliver(await fixture().open(), approved, 3);
    expect(onEngine).toEqual(onFixture);
    const keys = onEngine.filter((r) => r.table === 'invoice').map((r) => r.row[0]);
    expect(keys).toEqual(expect.arrayContaining(['INV/2024/001', 'فاکتور-۱', ' padded ', '0000']));
    for (const delivered of onEngine) {
      for (const column of INVOICE_ARCHIVE_EXCLUDED_COLUMNS) {
        expect(delivered.columns).not.toContain(column);
      }
      for (const secret of Object.values(SYNTHETIC_ARCHIVE_SECRETS)) {
        expect(delivered.row).not.toContain(secret);
      }
    }
  });

  it('refuses another approval before delivering a single row', async () => {
    const v1 = (await readImportV1Identity(await fixture().open())).fingerprint;
    const onBatch = vi.fn();
    await expect(
      withBoundReadSetSession(engine(), v1, (session) =>
        readApprovedInvoiceArchiveReadSet(session, 'e'.repeat(64), { batchSize: 2, onBatch }),
      ),
    ).rejects.toThrow(/READ_SET_FINGERPRINT_MISMATCH/u);
    expect(onBatch).not.toHaveBeenCalled();
  });
});
