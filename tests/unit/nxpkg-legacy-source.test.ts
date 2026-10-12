import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEGACY_TABLE_CLASSIFICATION, isLegacyTableRowReadable } from '@nexa/contracts';
import { openNxpkg } from '../../apps/api/src/infrastructure/nxpkg/reader';
import { INVOICE_ARCHIVE_READ_SET } from '../../apps/api/src/modules/platform/legacy-importer/application/invoice-archive-read-set';
import { takeLegacyInventory } from '../../apps/api/src/modules/platform/legacy-importer/application/legacy-inventory';
import { PRODUCTS_READ_SET } from '../../apps/api/src/modules/platform/legacy-importer/application/products-read-set';
import {
  USER_STATUS_READ_SET,
  readLegacyReadSet,
} from '../../apps/api/src/modules/platform/legacy-importer/application/read-set';
import {
  EvidenceUnsupported,
  LegacySourceRefused,
  type LegacySourceConnector,
} from '../../apps/api/src/modules/platform/legacy-importer/application/source-port';
import { readFromSession } from '../../apps/api/src/modules/platform/legacy-importer/application/source-snapshot';
import { FixtureLegacySourceConnector } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/fixture-legacy-source';
import {
  NxpkgLegacySourceConnector,
  nxpkgSourceConnector,
} from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/nxpkg-legacy-source';
import { guardTarget } from '../../apps/api/src/legacy-import.cli';
import { decideEvidenceClass } from '../../apps/api/src/modules/platform/legacy-importer/application/production-guard';
import { buildSyntheticLegacyDataset } from '../fixtures/legacy/synthetic-legacy';
import { newRawKey, writeNxpkg } from '../support/nxpkg/writer';
import {
  READY_MANIFEST,
  snapshotOfDataset,
  snapshotPackageFiles,
  writeSnapshotDirectory,
  type SnapshotParts,
} from '../support/nxpkg-legacy-package';

/**
 * Mirza `.nxpkg` importer — the package-backed legacy source (`nxpkg-legacy-source.ts`).
 *
 * The one claim that matters: the SAME rows, read from a package instead of the fixture adapter
 * (or MySQL), give the importer the SAME v1 fingerprint, the same read-set fingerprints and the
 * same inventory — so the owner's approval, resume and reconcile mean what they always meant.
 * Then: every way a snapshot can be wrong is refused, never read around. SYNTHETIC data only.
 */

/** The v1 fingerprint `legacy-import-read-set-v1.test.ts` pins for the synthetic dataset. */
const SYNTHETIC_V1_FINGERPRINT = '4b2bc6f8d96f565f665bb9c5f709a0ef0a95727755dd24ee04b23265fc9bf5e3';
/** The same rows without the synthetic marker: what a real copy prints. */
const UNMARKED_V1_FINGERPRINT = 'f55268747c0e8007b114cc3c5a26d6fd38e7d1af818bf32faff464cc82177e55';

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'nxpkg-source-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

let n = 0;
async function directory(parts: SnapshotParts): Promise<NxpkgLegacySourceConnector> {
  const dir = join(root, `dir-${String((n += 1))}`);
  await writeSnapshotDirectory(dir, parts, {
    ...READY_MANIFEST,
    import_id: '0123456789abcdef0123456789abcdef',
  });
  return NxpkgLegacySourceConnector.fromDirectory(dir);
}

async function identity(connector: LegacySourceConnector) {
  const session = await connector.open();
  try {
    const snapshot = await readFromSession(connector.label, session);
    const products = await readLegacyReadSet(session, PRODUCTS_READ_SET);
    const archive = await readLegacyReadSet(session, INVOICE_ARCHIVE_READ_SET);
    const status = await readLegacyReadSet(session, USER_STATUS_READ_SET);
    return {
      fingerprint: snapshot.fingerprint,
      schemaHash: snapshot.schemaHash,
      tables: snapshot.tables,
      synthetic: snapshot.synthetic,
      userStatus: snapshot.userStatus.fingerprint,
      users: snapshot.users,
      liveInvoices: snapshot.liveInvoices,
      products: products.fingerprint,
      archive: archive.fingerprint,
      status: status.fingerprint,
    };
  } finally {
    await session.close();
  }
}

async function refusal(connector: LegacySourceConnector): Promise<unknown> {
  return identity(connector).then(
    () => null,
    (e: unknown) => e,
  );
}

describe('NxpkgLegacySourceConnector', () => {
  it('equivalence: the NXPKG adapter and the fixture adapter give the same v1, read-set and inventory fingerprints for the same rows', async () => {
    for (const variant of [
      {},
      { productReview: 'A' as const },
      { invoiceArchive: 'A' as const },
      { extraUsers: 25 },
    ]) {
      const dataset = buildSyntheticLegacyDataset(variant);
      const fixture = new FixtureLegacySourceConnector(dataset as never);
      const parts = snapshotOfDataset(dataset as never);

      // The package form, through the real reader and the test writer.
      const key = newRawKey();
      const written = await writeNxpkg(join(root, `eq-${String((n += 1))}.nxpkg`), {
        files: snapshotPackageFiles(parts),
        secret: { rawKey: key.rawKey },
        manifest: READY_MANIFEST,
      });
      const viaPackage = await nxpkgSourceConnector(
        written.path,
        { keyFileText: key.keyFileText },
        root,
      );
      const viaDirectory = await directory(parts);
      try {
        const expected = await identity(fixture);
        expect(await identity(viaPackage), JSON.stringify(variant)).toEqual(expected);
        expect(await identity(viaDirectory), JSON.stringify(variant)).toEqual(expected);
        const catalogue = Object.keys(LEGACY_TABLE_CLASSIFICATION);
        const inventory = await takeLegacyInventory(fixture, expected.fingerprint, catalogue);
        // Everything but the engine name, which says where the rows came from.
        expect(await takeLegacyInventory(viaPackage, expected.fingerprint, catalogue)).toEqual({
          ...inventory,
          engine: 'NXPKG',
        });
        if (Object.keys(variant).length === 0) {
          expect(expected.fingerprint).toBe(SYNTHETIC_V1_FINGERPRINT);
        }
      } finally {
        await viaPackage.close();
      }
      // The connector owned the decrypted package: closing it closed (and deleted) it.
      await expect(viaPackage.pkg?.readJson('source/catalog.json')).rejects.toThrow(/closed/u);
      await expect(viaPackage.open()).rejects.toThrow(/closed/u);
    }
  });

  it('descriptor, label, aggregate and the synthetic marker', async () => {
    const parts = snapshotOfDataset(buildSyntheticLegacyDataset() as never);
    const connector = await directory(parts);
    expect(connector.descriptor).toEqual({
      engine: 'NXPKG',
      version: 'mirza2nexa 0.6.0 / contract 1.4.0',
      readOnlyProof: { kind: 'NOT_APPLICABLE' },
    });
    expect(connector.label).toBe('nxpkg import 0123456789abcdef0123456789abcdef');
    const session = await connector.open();
    await expect(session.aggregate('SELECT 1')).rejects.toBeInstanceOf(EvidenceUnsupported);
    expect(await session.syntheticMarker()).toBe('SYNTHETIC legacy fixture v1 (not evidence)');
    await session.close();
    expect(() => session.columns()).toThrow(/closed/u);
  });

  it('a REAL package (marker null) is not synthetic: its fingerprint is the unmarked one, a production-like target is guarded as for any real source', async () => {
    const dataset = buildSyntheticLegacyDataset();
    const real = {
      ...dataset,
      schema: dataset.schema.filter((c) => c.table !== 'nexa_synthetic_fixture'),
    };
    const connector = await directory(snapshotOfDataset(real as never));
    expect(connector.syntheticMarker).toBeNull();
    const id = await identity(connector);
    expect(id.synthetic).toBe(false);
    expect(id.fingerprint).toBe(UNMARKED_V1_FINGERPRINT);
    expect(
      decideEvidenceClass({ claim: 'staging', syntheticSource: false, productionLikeTarget: true }),
    ).toMatchObject({ ok: true });

    // The guard: a real package against a production-like target needs the flag and the ack…
    const target = 'postgres://nexa@db.example:5432/nexa';
    const args = { tenant: 'acme', allowProductionTarget: false, source: 'nxpkg:/x.nxpkg' };
    expect(() => guardTarget({ ...args, syntheticSource: false }, target, {})).toThrow(
      /looks like production/u,
    );
    // …and a SYNTHETIC package is refused there even with both.
    const ack = /NEXA_LEGACY_IMPORT_TARGET_ACK=([0-9a-f]{16})/u.exec(
      (() => {
        try {
          guardTarget({ ...args, syntheticSource: false }, target, {});
          return '';
        } catch (e) {
          return (e as Error).message;
        }
      })(),
    )?.[1];
    expect(ack).toMatch(/^[0-9a-f]{16}$/u);
    const armed = { ...args, allowProductionTarget: true };
    const env = { NEXA_LEGACY_IMPORT_TARGET_ACK: ack };
    expect(guardTarget({ ...armed, syntheticSource: false }, target, env).productionLike).toBe(
      true,
    );
    expect(() => guardTarget({ ...armed, syntheticSource: true }, target, env)).toThrow(
      /SYNTHETIC/u,
    );
    // A fixture source stays synthetic whatever the flag says.
    expect(() =>
      guardTarget({ ...armed, source: 'fixture:/x.json', syntheticSource: false }, target, env),
    ).toThrow(/SYNTHETIC/u);
    // A synthetic snapshot on a production-like target is refused by the evidence class too.
    expect(
      decideEvidenceClass({ claim: null, syntheticSource: true, productionLikeTarget: true }),
    ).toMatchObject({ ok: false });
  });

  describe('refusals', () => {
    const base = () => snapshotOfDataset(buildSyntheticLegacyDataset() as never);
    const userRows = (parts: SnapshotParts) => parts.tables.user;
    const setRows = (parts: SnapshotParts, rows: number) => {
      const catalog = parts.catalog as Record<string, any>;
      catalog.snapshot_tables.user.rows = rows;
      catalog.tables.find((t: { name: string }) => t.name === 'user').rows = rows;
    };

    it('a row out of primary-key byte order', async () => {
      const parts = base();
      const rows = userRows(parts);
      [rows[1], rows[2]] = [rows[2] as Record<string, unknown>, rows[1] as Record<string, unknown>];
      const error = await refusal(await directory(parts));
      expect(error).toBeInstanceOf(LegacySourceRefused);
      expect((error as LegacySourceRefused).code).toBe('SOURCE_UNREADABLE');
      expect((error as Error).message).toMatch(/ascending primary-key byte order/u);
    });

    it('a duplicate primary key (the counts made to agree)', async () => {
      const parts = base();
      const rows = userRows(parts);
      rows.splice(2, 0, rows[1] as Record<string, unknown>);
      setRows(parts, rows.length - 1);
      const error = await refusal(await directory(parts));
      expect((error as LegacySourceRefused).code).toBe('SOURCE_UNREADABLE');
      expect((error as Error).message).toMatch(/out of order or repeated/u);
    });

    it('a NULL primary key, a row missing, a malformed row, a header that disagrees', async () => {
      const nullKey = base();
      (userRows(nullKey)[1] as { c: (string | null)[] }).c[0] = null;
      expect(((await refusal(await directory(nullKey))) as Error).message).toMatch(
        /without a primary key/u,
      );

      const missing = base();
      userRows(missing).splice(3, 1);
      expect(((await refusal(await directory(missing))) as Error).message).toMatch(
        /another number of rows/u,
      );

      const malformed = base();
      (userRows(malformed)[2] as { c: unknown[] }).c.push('extra');
      expect(((await refusal(await directory(malformed))) as Error).message).toMatch(
        /malformed row/u,
      );

      const header = base();
      (userRows(header)[0] as { table: string }).table = 'invoice';
      expect(((await refusal(await directory(header))) as Error).message).toMatch(
        /header disagrees/u,
      );
    });

    it('a column the catalogue lists but the rows file does not carry is refused, never read as NULL', async () => {
      const parts = base();
      const catalog = parts.catalog as Record<string, any>;
      const columns: string[] = catalog.snapshot_tables.user.columns;
      const at = columns.indexOf('agent');
      columns.splice(at, 1);
      for (const row of userRows(parts).slice(1)) (row as { c: unknown[] }).c.splice(at, 1);
      (userRows(parts)[0] as { columns: string[] }).columns = [...columns];
      const error = await refusal(await directory(parts));
      expect(error).toBeInstanceOf(LegacySourceRefused);
      expect((error as LegacySourceRefused).code).toBe('SOURCE_SCHEMA_MISSING_COLUMN');
    });

    it('a table outside the snapshot, a table the catalogue does not let a read set read, another key, a non-identifier', async () => {
      const connector = await directory(base());
      const session = await connector.open();
      const readable = Object.keys(LEGACY_TABLE_CLASSIFICATION).find(
        (t) => isLegacyTableRowReadable(t) && !['user', 'invoice', 'product'].includes(t),
      );
      expect(readable).toBeDefined();
      const code = (fn: () => unknown) => {
        try {
          fn();
          return null;
        } catch (e) {
          return (e as LegacySourceRefused).code;
        }
      };
      expect(code(() => session.readSetRows(readable as string, 'id', ['id']))).toBe(
        'SOURCE_TABLE_NOT_READABLE',
      );
      expect(code(() => session.readSetRows('nexa_synthetic_unclassified', 'id', ['id']))).toBe(
        'SOURCE_TABLE_NOT_READABLE',
      );
      expect(code(() => session.readSetRows('user', 'username', ['id']))).toBe('SOURCE_UNREADABLE');
      expect(code(() => session.readSetRows('user', 'id', ['id', 'affiliates']))).toBe(
        'SOURCE_SCHEMA_MISSING_COLUMN',
      );
      expect(code(() => session.readSetRows('user; DROP', 'id', ['id']))).toBe(
        'SOURCE_TABLE_NOT_READABLE',
      );
      // `rows` holds the v1 vocabulary, as the MySQL adapter does.
      expect(() => session.rows('user', ['id', 'affiliates'])).toThrow(/outside the v1/u);
      await expect(session.countRows('no_such_table')).rejects.toThrow(/not a table/u);
      await session.close();
    });

    it('a package without the snapshot, or a catalogue that is not one source', async () => {
      const key = newRawKey();
      const written = await writeNxpkg(join(root, 'nosnap.nxpkg'), {
        files: { 'records/customers.jsonl': { records: [] } },
        secret: { rawKey: key.rawKey },
        manifest: READY_MANIFEST,
      });
      await expect(
        nxpkgSourceConnector(written.path, { keyFileText: key.keyFileText }, root),
      ).rejects.toMatchObject({ code: 'SOURCE_SCHEMA_MISSING_TABLE' });

      const lying = base();
      (lying.catalog as Record<string, unknown>)['synthetic_marker'] = null; // the table stays
      await expect(directory(lying)).rejects.toThrow(/synthetic_marker disagrees/u);

      const otherKey = base();
      (otherKey.catalog as Record<string, any>).snapshot_tables.user.primary_key = 'username';
      await expect(directory(otherKey)).rejects.toThrow(/primary key is not the v1 one/u);

      const unknownField = base();
      (unknownField.catalog as Record<string, unknown>)['extra'] = 1;
      await expect(directory(unknownField)).rejects.toThrow(/unexpected set of fields/u);

      const dropped = base();
      (dropped.catalog as Record<string, any>).snapshot_tables.user.rows = 10;
      await expect(directory(dropped)).rejects.toThrow(/does not hold every row/u);
    });

    it('the converter-written fixture package opens and reads end to end (cross-language)', async () => {
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
        expect(connector.descriptor.engine).toBe('NXPKG');
        const id = await identity(connector);
        expect(id.synthetic).toBe(true);
        expect(id.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
        expect(id.tables.user.rows).toBeGreaterThan(0);
        // Deterministic: a second read of the same package is the same identity.
        expect(await identity(connector)).toEqual(id);
      } finally {
        await pkg.close();
      }
    });
  });

  it('writes nothing: a directory source is read, never modified', async () => {
    const parts = base2();
    const dir = join(root, 'ro');
    await writeSnapshotDirectory(dir, parts, { ...READY_MANIFEST });
    const before = await readFile(join(dir, 'source', 'tables', 'user.jsonl'));
    await identity(await NxpkgLegacySourceConnector.fromDirectory(dir));
    expect(await readFile(join(dir, 'source', 'tables', 'user.jsonl'))).toEqual(before);
    await writeFile(join(dir, 'source', 'catalog.json'), 'not json');
    await expect(NxpkgLegacySourceConnector.fromDirectory(dir)).rejects.toThrow(/strict JSON/u);
  });
});

function base2(): SnapshotParts {
  return snapshotOfDataset(buildSyntheticLegacyDataset() as never);
}
