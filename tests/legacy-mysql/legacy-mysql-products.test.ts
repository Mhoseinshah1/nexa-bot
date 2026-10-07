import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ProductObservationAssembler,
  digestProductsReadSet,
  liveInvoiceCountsByCode,
  readApprovedProductsReadSet,
} from '../../apps/api/src/modules/platform/legacy-importer/application/products-read-set';
import { withBoundReadSetSession } from '../../apps/api/src/modules/platform/legacy-importer/application/read-set';
import { readImportV1Identity } from '../../apps/api/src/modules/platform/legacy-importer/application/source-snapshot';
import { FixtureLegacySourceConnector } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/fixture-legacy-source';
import {
  MysqlLegacySourceConnector,
  parseMysqlDsn,
} from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/mysql-legacy-source';
import {
  buildSyntheticLegacyDataset,
  syntheticLegacySql,
} from '../fixtures/legacy/synthetic-legacy';

/**
 * Mirza migration PR2 — the `products` read set on a REAL engine (CI's `legacy-mysql`
 * matrix: MariaDB 10.11 and MySQL 8.0). FAILS without `NEXA_LEGACY_MYSQL_ADMIN_DSN`, never
 * skips. SYNTHETIC data only (the product-review variant); NOT EVIDENCE.
 */

const ADMIN_DSN = process.env['NEXA_LEGACY_MYSQL_ADMIN_DSN'];
const DATABASE = 'nexa_legacy_products_t';
const RO = { user: 'nexa_legacy_prod_ro_t', password: 'ro-products-synthetic-pw' };

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
  new FixtureLegacySourceConnector(buildSyntheticLegacyDataset({ productReview: 'A' }) as never);

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
  await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
  await admin.query(`CREATE DATABASE \`${DATABASE}\``);
  await admin.query(`USE \`${DATABASE}\``);
  await admin.query(syntheticLegacySql(buildSyntheticLegacyDataset({ productReview: 'A' })));
  await admin.query(`DROP USER IF EXISTS '${RO.user}'@'%'`);
  await admin.query(`CREATE USER '${RO.user}'@'%' IDENTIFIED BY '${RO.password}'`);
  await admin.query(`GRANT SELECT ON \`${DATABASE}\`.* TO '${RO.user}'@'%'`);
}, 120_000);

afterAll(async () => {
  await admin?.end();
});

describe('the products read set on the engine', () => {
  it('fingerprints exactly as the fixture does, and leaves v1 as it was', async () => {
    const expected = await digestProductsReadSet(await fixture().open());
    const v1 = (await readImportV1Identity(await fixture().open())).fingerprint;
    const read = await withBoundReadSetSession(engine(), v1, async (session) => {
      const products = await digestProductsReadSet(session);
      const after = await readImportV1Identity(session);
      return { products, after };
    });
    expect(read.products.fingerprint).toBe(expected.fingerprint);
    expect(read.products.tables).toEqual(expected.tables);
    expect(read.after.fingerprint).toBe(v1);
  });

  it('delivers under the approval the same observations as the fixture; refuses another', async () => {
    const v1 = (await readImportV1Identity(await fixture().open())).fingerprint;
    const approved = (await digestProductsReadSet(await fixture().open())).fingerprint;
    const collect = async (session: Parameters<typeof liveInvoiceCountsByCode>[0]) => {
      const assembler = new ProductObservationAssembler(await liveInvoiceCountsByCode(session));
      await readApprovedProductsReadSet(session, approved, {
        batchSize: 2,
        onBatch: (batch) => assembler.take(batch),
      });
      return { observations: assembler.finish(), skipped: assembler.skipped };
    };
    const onEngine = await withBoundReadSetSession(engine(), v1, collect);
    const onFixture = await collect(await fixture().open());
    expect(onEngine).toEqual(onFixture);

    const onBatch = vi.fn();
    await expect(
      withBoundReadSetSession(engine(), v1, (session) =>
        readApprovedProductsReadSet(session, 'e'.repeat(64), { batchSize: 2, onBatch }),
      ),
    ).rejects.toThrow(/READ_SET_FINGERPRINT_MISMATCH/u);
    expect(onBatch).not.toHaveBeenCalled();
  });
});
