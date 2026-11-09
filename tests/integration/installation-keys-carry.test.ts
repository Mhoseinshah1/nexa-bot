import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../apps/api/src/infrastructure/persistence/migrate';
import { kekFingerprint } from '../../apps/api/src/infrastructure/crypto/kek';
import { wrapInstallationKey } from '../../apps/api/src/infrastructure/crypto/installation-keyring';
import { PgCandidateKeyStore } from '../../apps/api/src/modules/platform/recovery/infrastructure/installation-key-adapters';
import { testConfig } from './harness';

/**
 * The decrypt-only keys an installation still holds from a Recovery Kit imported before the
 * kit was removed (SFR A1) survive a restore: the executor carries them into the candidate,
 * keeps a tombstone a tombstone, and flags a key only the backup had. Moved here from the
 * removed `recovery-kit-restore.test.ts`; the rows are seeded directly, since nothing imports
 * a key any more.
 */
describe('the stored decrypt-only keys across a restore', () => {
  let created: string[];

  const admin = (): Client => {
    const base = new URL(testConfig().DATABASE_URL);
    base.pathname = '/postgres';
    return new Client({ connectionString: base.toString() });
  };

  async function maintenance(sql: string): Promise<void> {
    const client = admin();
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  }

  async function queryIn<T extends Record<string, unknown>>(
    database: string,
    sql: string,
  ): Promise<T[]> {
    const url = new URL(testConfig().DATABASE_URL);
    url.pathname = `/${database}`;
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    try {
      return (await client.query<T>(sql)).rows;
    } finally {
      await client.end();
    }
  }

  beforeEach(() => {
    created = [];
  });

  afterEach(async () => {
    for (const name of created) {
      await maintenance(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
    }
  });

  it('carries a TOMBSTONE into the candidate, and flags a key only the backup had', async () => {
    // The candidate is an older backup: it still holds `removed-1` (removed here
    // since) and `stranger-1` (never imported here). Without the tombstone the
    // restore would quietly bring `removed-1` back.
    const database = `nexa_kitlive_${randomBytes(6).toString('hex')}`;
    created.push(database);
    await maintenance(`CREATE DATABASE "${database}"`);
    const url = new URL(testConfig().DATABASE_URL);
    url.pathname = `/${database}`;
    await runMigrations(url.toString());

    const wrapping = randomBytes(32);
    const removed = randomBytes(32);
    const stranger = randomBytes(32);
    const live = (keyId: string, material: Buffer) =>
      `('${randomUUID()}', '${keyId}', '${kekFingerprint(material)}', '${wrapInstallationKey({
        keyId,
        material,
        wrappingKeyId: 'kek-old',
        wrappingKey: wrapping,
      })}', 'kek-old', 'RECOVERY_KIT', now())`;
    await queryIn(
      database,
      `INSERT INTO installation_keys
         (id, key_id, fingerprint, wrapped_material, wrapped_under_key_id, source, imported_at)
       VALUES ${live('removed-1', removed)}, ${live('stranger-1', stranger)}`,
    );

    const store = new PgCandidateKeyStore(testConfig().DATABASE_URL, 'not-this-one');
    const arrived = await store.carryInto(database, [
      {
        id: randomUUID(),
        keyId: 'removed-1',
        fingerprint: kekFingerprint(removed),
        wrappedMaterial: null,
        wrappedUnderKeyId: null,
        source: 'RECOVERY_KIT',
        kitId: null,
        importedAt: new Date(),
        importedByAdminId: null,
        importedByLabel: 'owner',
        removedAt: new Date(),
        removedByLabel: 'owner',
        restoredAt: null,
      },
    ]);
    expect(arrived).toEqual(['stranger-1']);
    const rows = await queryIn<{
      key_id: string;
      wrapped_material: string | null;
      removed_at: string | null;
      restored_at: string | null;
    }>(
      database,
      'SELECT key_id, wrapped_material, removed_at, restored_at FROM installation_keys ORDER BY key_id',
    );
    expect(rows.find((r) => r.key_id === 'removed-1')).toMatchObject({ wrapped_material: null });
    expect(rows.find((r) => r.key_id === 'removed-1')?.removed_at).not.toBeNull();
    expect(rows.find((r) => r.key_id === 'stranger-1')?.restored_at).not.toBeNull();
  });
});
