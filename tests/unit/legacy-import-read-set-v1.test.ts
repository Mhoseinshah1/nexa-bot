import { describe, expect, it } from 'vitest';
import {
  IMPORT_READ_SET_V1,
  LEGACY_OPTIONAL_COLUMNS,
  LEGACY_PRIMARY_KEYS,
  LEGACY_REQUIRED_COLUMNS,
  LEGACY_SOURCE_TABLES,
} from '../../apps/api/src/modules/platform/legacy-importer/application/source-port';
import {
  LEGACY_FINGERPRINT_VERSION,
  legacyFingerprint,
  readFromSession,
} from '../../apps/api/src/modules/platform/legacy-importer/application/source-snapshot';
import { FixtureLegacySourceConnector } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/fixture-legacy-source';
import { buildSyntheticLegacyDataset } from '../fixtures/legacy/synthetic-legacy';

/**
 * The import read set is FROZEN as v1 (Mirza migration PR1, `docs/legacy-migration/
 * importer.md` §Read sets).
 *
 * The owner approves ONE value for a legacy source: the v1 fingerprint `audit` prints. That
 * value is a function of the import read set — its tables, keys, columns, exclusions, JSON
 * encoding and version string. Before this file nothing pinned it: the source tests assert
 * only RELATIVE behaviour (deterministic, changes when a column changes), so adding one
 * column to `LEGACY_OPTIONAL_COLUMNS` — or a table to `LEGACY_SOURCE_TABLES`, through
 * `legacySchemaHash`'s filter — would have changed every fingerprint, voided the approval,
 * and passed CI.
 *
 * These literals are over the SYNTHETIC fixture only. They are not, and must never become,
 * an expectation about real data. If a reviewed change MUST alter v1, it is a new version
 * (`legacy-source-fingerprint:v2`) with an owner decision — never an edit of these values.
 */

/** sha256 of the synthetic dataset's v1 identity, with the synthetic marker. */
const SYNTHETIC_V1_FINGERPRINT = '4b2bc6f8d96f565f665bb9c5f709a0ef0a95727755dd24ee04b23265fc9bf5e3';
/** sha256 of the sorted `table.column:data_type` lines of user, invoice, product. */
const SYNTHETIC_V1_SCHEMA_HASH = 'ff077d2a779559275c1c8ed5d04f23c0737a7f7470960bab33d648fa495c0acb';
/** The same rows' fingerprint WITHOUT the synthetic marker: what a real copy would print. */
const UNMARKED_V1_FINGERPRINT = 'f55268747c0e8007b114cc3c5a26d6fd38e7d1af818bf32faff464cc82177e55';

const SYNTHETIC_V1_TABLES = {
  user: {
    rows: 11,
    columns: ['id', 'Balance', 'limit_usertest', 'agent', 'username'],
    digest: 'edc2594f97fc8023a1fee8e72bb24d3e853d4e90e97de433c0ee11dc93400095',
  },
  invoice: {
    rows: 21,
    columns: [
      'id_invoice',
      'id_user',
      'username',
      'Status',
      'is_test',
      'code_panel',
      'code_product',
      'Volume',
      'Service_time',
      'time_unit',
      'is_custom',
      'price_product',
    ],
    digest: 'df9381d54036888d4351e12d1435905a618338947fc0daa751a6ab6b31f647a4',
  },
  product: {
    rows: 2,
    columns: ['id', 'code_product', 'agent'],
    digest: '66bfb3b4cf802b1c7574fd6d30b144b8a0df2eff4b4e5807c5b2ce025d526c80',
  },
};

async function syntheticSnapshot() {
  const connector = new FixtureLegacySourceConnector(buildSyntheticLegacyDataset() as never);
  return readFromSession(connector.label, await connector.open());
}

describe('the import read set v1 is frozen', () => {
  it('pins the synthetic v1 fingerprint, its schema hash and every table digest', async () => {
    const snapshot = await syntheticSnapshot();
    expect(snapshot.schemaHash).toBe(SYNTHETIC_V1_SCHEMA_HASH);
    expect(snapshot.tables).toEqual(SYNTHETIC_V1_TABLES);
    expect(snapshot.fingerprint).toBe(SYNTHETIC_V1_FINGERPRINT);
  });

  it('pins the unmarked form too: the synthetic flag is only ever ADDED to v1', async () => {
    const snapshot = await syntheticSnapshot();
    expect(legacyFingerprint(snapshot.schemaHash, snapshot.tables, false)).toBe(
      UNMARKED_V1_FINGERPRINT,
    );
  });

  it('pins the read set itself, literally', () => {
    expect(LEGACY_FINGERPRINT_VERSION).toBe('legacy-source-fingerprint:v1');
    expect(IMPORT_READ_SET_V1).toEqual({
      fingerprintVersion: 'legacy-source-fingerprint:v1',
      tables: ['user', 'invoice', 'product'],
      primaryKeys: { user: 'id', invoice: 'id_invoice', product: 'id' },
      requiredColumns: {
        user: ['id', 'Balance', 'limit_usertest'],
        invoice: SYNTHETIC_V1_TABLES.invoice.columns,
        product: ['id', 'code_product'],
      },
      optionalColumns: { user: ['agent', 'number', 'username'], invoice: [], product: ['agent'] },
      notFingerprinted: ['user.number'],
    });
    // The historical names are the frozen object, not copies that could drift from it.
    expect(LEGACY_SOURCE_TABLES).toBe(IMPORT_READ_SET_V1.tables);
    expect(LEGACY_PRIMARY_KEYS).toBe(IMPORT_READ_SET_V1.primaryKeys);
    expect(LEGACY_REQUIRED_COLUMNS).toBe(IMPORT_READ_SET_V1.requiredColumns);
    expect(LEGACY_OPTIONAL_COLUMNS).toBe(IMPORT_READ_SET_V1.optionalColumns);
  });

  it('cannot be widened at run time', () => {
    expect(Object.isFrozen(IMPORT_READ_SET_V1)).toBe(true);
    expect(() => (IMPORT_READ_SET_V1.tables as unknown as string[]).push('setting')).toThrow(
      TypeError,
    );
    expect(() =>
      (IMPORT_READ_SET_V1.optionalColumns.user as unknown as string[]).push('affiliates'),
    ).toThrow(TypeError);
    expect(IMPORT_READ_SET_V1.tables).toEqual(['user', 'invoice', 'product']);
  });
});
