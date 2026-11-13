import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActorContext } from '@nexa/contracts';
import { type Container } from '../../apps/api/src/container';
import { createMigratedDatabase } from '../support/migrated-database';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { AesGcmSecretCipher } from '../../apps/api/src/infrastructure/crypto/secret-cipher';
import { kekFingerprint } from '../../apps/api/src/infrastructure/crypto/kek';
import { wrapInstallationKey } from '../../apps/api/src/infrastructure/crypto/installation-keyring';
import {
  trialDecryptSecrets,
  type SecretRowQueryable,
} from '../../apps/api/src/infrastructure/crypto/secret-trial';
import { createTestContainer, adminActorFor, createAdmin, tenantA, testConfig } from './harness';

/**
 * NEXA-FIX-RESTORE-SECRETS, end to end: two installations, real backups, the real
 * restore test and the real executor's cutover.
 *
 * The incident: install A and install B were made on the same day, so both keys
 * were named `install-20261107`, with different bytes. A backup of A restored on B;
 * the id-only check found the name, cut over, and every secret failed
 * authentication. Each case builds THROWAWAY live databases, because the cutover
 * renames the database it runs against.
 */

const SAME_ID = 'install-20261107';
const OWNER_PASSWORD = 'the-owners-real-password';
const BACKUP_PASSWORD = 'the backup password A used';

describe('a restore never brings back secrets this install cannot read', () => {
  let created: string[];
  const roots: string[] = [];
  const containers: Container[] = [];

  const urlOf = (database: string): string => {
    const url = new URL(testConfig().DATABASE_URL);
    url.pathname = `/${database}`;
    return url.toString();
  };

  async function maintenance(sql: string): Promise<void> {
    const base = new URL(testConfig().DATABASE_URL);
    base.pathname = '/postgres';
    const client = new Client({ connectionString: base.toString() });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  }

  async function withDb<T>(database: string, fn: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: urlOf(database) });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function installation(keyId: string, material: Buffer) {
    const database = `nexa_rskey_${randomBytes(6).toString('hex')}`;
    created.push(database);
    await createMigratedDatabase(testConfig().DATABASE_URL, database);
    const workRoot = await mkdtemp(join(tmpdir(), 'nexa-rskey-backups-'));
    const recoveryRoot = await mkdtemp(join(tmpdir(), 'nexa-rskey-recovery-'));
    roots.push(workRoot, recoveryRoot);
    const container = createTestContainer(
      testConfig({
        DATABASE_URL: urlOf(database),
        BACKUP_WORK_DIR: workRoot,
        RECOVERY_WORK_DIR: recoveryRoot,
        SECRETS_KEYS: `${keyId}:${material.toString('base64')}`,
        SECRETS_ACTIVE_KEY_ID: keyId,
      }),
      'recovery',
    );
    containers.push(container);
    await seed(container.database.db, container.cipher);
    container.setInstallationTenant(tenantA.tenantId);
    const owner: ActorContext = adminActorFor(
      await createAdmin(container, tenantA, {
        username: `owner-${randomBytes(3).toString('hex')}`,
        password: OWNER_PASSWORD,
        roleKeys: ['owner'],
      }),
    );
    return { container, database, workRoot, owner, keyId, material };
  }
  type Install = Awaited<ReturnType<typeof installation>>;

  async function setBackupPassword(install: Install): Promise<void> {
    await install.container.backupPasswords.set(
      tenantA,
      install.owner,
      {
        idempotencyKey: `set-${randomBytes(6).toString('hex')}`,
        password: BACKUP_PASSWORD,
        stepUp: { password: OWNER_PASSWORD },
      },
      { ip: null },
    );
  }

  /** A real backup run; the path of the archive it left (7z with a password, else .nxb). */
  async function backupOf(install: Install): Promise<string> {
    const outcome = await install.container.backup.run('MANUAL');
    if (outcome.kind !== 'COMPLETED') throw new Error(`backup did not complete: ${outcome.kind}`);
    expect(outcome.run.state).toBe('SUCCEEDED');
    const name = outcome.run.archiveFormat === 'SEVEN_ZIP' ? 'archive.7z' : 'archive.nxb';
    return join(install.workRoot, outcome.run.id, name);
  }

  async function upload(install: Install, archivePath: string, archivePassword?: string) {
    const begun = await install.container.recoveryService.beginUpload(tenantA, install.owner, {
      clientFilename: 'old-server.7z',
    });
    await copyFile(archivePath, begun.workspace.archivePath);
    const { size } = await stat(begun.workspace.archivePath);
    await install.container.recoveryService.completeUpload(tenantA, begun.request.id, {
      sizeBytes: size,
      archiveSha256: 'a'.repeat(64),
    });
    return install.container.recoveryService.verifyAndTest(
      tenantA,
      install.owner,
      begun.request.id,
      archivePassword === undefined ? {} : { archivePassword },
    );
  }

  async function confirmAndExecute(
    install: Install,
    request: { id: string; artifactChecksum: string | null },
  ) {
    await install.container.recoveryService.confirm(tenantA, install.owner, request.id, {
      phrase: 'RESTORE NEXA',
      artifactChecksum: request.artifactChecksum ?? '',
    });
    await install.container.recoveryExecutor.tick();
    const row = await install.container.recoveryRequests.byIdUnscoped(request.id);
    created.push(row?.displacedDatabase ?? '');
    return row;
  }

  /** Every stored secret's plaintext, by purpose/entity, read with `cipher`. */
  async function plaintexts(database: string, cipher: AesGcmSecretCipher) {
    return withDb(database, async (client) => {
      const out = new Map<string, string>();
      const { rows } = await client.query<{
        id: string;
        tenant_id: string;
        token_ciphertext: string;
        token_key_id: string;
      }>('SELECT id, tenant_id, token_ciphertext, token_key_id FROM bot_instances ORDER BY id');
      for (const row of rows) {
        out.set(
          row.id,
          cipher.decrypt(
            { keyId: row.token_key_id, ciphertext: row.token_ciphertext },
            { purpose: 'bot_instance.token', tenantId: row.tenant_id, entityId: row.id },
          ),
        );
      }
      return out;
    });
  }

  /** The trial on `database`, with ONE key: `keyId:material`, nothing else. */
  async function trialWithOnly(database: string, keyId: string, material: Buffer) {
    const cipher = new AesGcmSecretCipher(
      { activeKeyId: keyId, format: 'canonical', keys: new Map([[keyId, material]]) },
      false,
    );
    return withDb(database, (client) =>
      trialDecryptSecrets(client as unknown as SecretRowQueryable, cipher),
    );
  }

  function onlyKey(keyId: string, material: Buffer): AesGcmSecretCipher {
    return new AesGcmSecretCipher(
      { activeKeyId: keyId, format: 'canonical', keys: new Map([[keyId, material]]) },
      false,
    );
  }

  /** No encoding of `material` anywhere in `text`. */
  function expectNoKey(text: string | Buffer, material: Buffer): void {
    const haystack = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8');
    expect(haystack.includes(material)).toBe(false);
    for (const encoding of ['base64', 'base64url', 'hex'] as const) {
      expect(haystack.includes(Buffer.from(material.toString(encoding), 'utf8'))).toBe(false);
    }
  }

  async function durableText(database: string): Promise<string> {
    return withDb(database, async (client) => {
      const parts: string[] = [];
      for (const table of [
        'backup_runs',
        'operational_events',
        'audit_logs',
        'recovery_requests',
      ]) {
        const { rows } = await client.query(`SELECT row_to_json(t)::text AS body FROM ${table} t`);
        parts.push(...rows.map((row: { body: string }) => row.body));
      }
      return parts.join('\n');
    });
  }

  beforeEach(() => {
    created = [];
  });

  afterEach(async () => {
    for (const container of containers.splice(0)) await container.shutdown().catch(() => undefined);
    for (const name of new Set(created.filter((name) => name !== ''))) {
      await maintenance(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
    }
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it.each([
    { name: 'the SAME key id with different bytes (the incident)', a: SAME_ID, b: SAME_ID },
    { name: 'different key ids', a: 'kek-a', b: 'kek-b' },
  ])(
    'restores A’s backup on B with only the file and the password — $name',
    async ({ a: idA, b: idB }) => {
      const keyA = randomBytes(32);
      const keyB = randomBytes(32);
      const a = await installation(idA, keyA);
      await setBackupPassword(a);
      const before = await plaintexts(a.database, onlyKey(idA, keyA));
      expect(before.size).toBeGreaterThan(0);
      const secretsInA = await trialWithOnly(a.database, idA, keyA);
      expect(secretsInA.unreadableTotal).toBe(0);
      const archivePath = await backupOf(a);

      // The archive, the bundle inside it and everything A recorded hold no key.
      const archive = await readFile(archivePath);
      expectNoKey(archive, keyA);
      const bundle = execFileSync('7z', ['x', '-so', '-bd', archivePath, 'keys.json'], {
        input: `${BACKUP_PASSWORD}\n`,
      });
      expect(bundle.length).toBeGreaterThan(0);
      expectNoKey(bundle, keyA);
      const manifest = execFileSync('7z', ['x', '-so', '-bd', archivePath, 'manifest.json'], {
        input: `${BACKUP_PASSWORD}\n`,
      });
      expectNoKey(manifest, keyA);
      expectNoKey(await durableText(a.database), keyA);
      await a.container.shutdown();
      containers.splice(containers.indexOf(a.container), 1);

      // --- B: a fresh install, no kit, nothing of A's but the file + password.
      const b = await installation(idB, keyB);
      const tested = await upload(b, archivePath, BACKUP_PASSWORD);
      expect(tested.failureCode).toBeNull();
      expect(tested.request.state).toBe('RESTORE_TEST_PASSED');
      expect(tested.request.restoreTest).toMatchObject({
        unreadableSecrets: [],
      });
      expect(tested.request.restoreTest?.bundledKeys).toBeGreaterThan(0);
      // Nothing was persisted as a key: the bundle's keys live for one recovery.
      expect(await b.container.installationKeyRepository.all()).toHaveLength(0);
      expect(b.container.keyring.importedKeys.size).toBe(0);

      const row = await confirmAndExecute(b, tested.request);
      expect(row?.failureCode ?? null).toBeNull();
      expect(row?.state).toBe('SUCCEEDED');
      expect(row?.restoreTest?.secretsRewrapped).toBeGreaterThan(0);

      // Every secret reads under B's ACTIVE key ALONE — nothing depends on A's key.
      const after = await trialWithOnly(b.database, idB, keyB);
      expect(after.unreadableTotal).toBe(0);
      expect(after.readableTotal).toBe(secretsInA.readableTotal);
      expect(await plaintexts(b.database, onlyKey(idB, keyB))).toEqual(before);
      // And A's key reads none of them any more.
      expect((await trialWithOnly(b.database, idA, keyA)).readableTotal).toBe(0);
      // B's records hold no key either.
      expectNoKey(await durableText(b.database), keyA);
      expectNoKey(await durableText(b.database), keyB);
    },
    300_000,
  );

  it('a wrong backup password opens nothing, imports nothing and changes nothing', async () => {
    const keyA = randomBytes(32);
    const a = await installation(SAME_ID, keyA);
    await setBackupPassword(a);
    const archivePath = await backupOf(a);
    await a.container.shutdown();
    containers.splice(containers.indexOf(a.container), 1);

    const keyB = randomBytes(32);
    const b = await installation(SAME_ID, keyB);
    const beforeB = await plaintexts(b.database, onlyKey(SAME_ID, keyB));
    const tested = await upload(b, archivePath, 'not the backup password');
    expect(tested.failureCode).toBe('recovery.archive_auth_failed');
    expect(tested.request.state).toBe('FAILED');
    expect(tested.request.restoreTest ?? null).toBeNull();
    expect(await b.container.installationKeyRepository.all()).toHaveLength(0);
    expect(b.container.keyring.importedKeys.size).toBe(0);
    expect(await plaintexts(b.database, onlyKey(SAME_ID, keyB))).toEqual(beforeB);
    expectNoKey(await durableText(b.database), keyA);
    expect(await durableText(b.database)).not.toContain('not the backup password');
  }, 300_000);

  it('SFR A1: an old archive (no bundled keys) is REFUSED, never half-restored, and a key a removed kit left here does not let it through', async () => {
    // MUTATION: the restore trial reading the installation's imported keys again (the Recovery
    // Kit's restore fallback, `KeyringRecoveryKeyCoverage.trialDecrypt` on `this.keyring`)
    // lets step 2 pass and fails this.
    const keyA = randomBytes(32);
    const a = await installation('kek-a', keyA);
    await setBackupPassword(a);
    // A release from before self-contained backups: its 7z carried no keys.
    (a.container.backupArchiver as unknown as { keyBundle?: unknown }).keyBundle = undefined;
    const archivePath = await backupOf(a);
    const listing = execFileSync('7z', ['l', '-slt', '-bd', archivePath], {
      input: `${BACKUP_PASSWORD}\n`,
      encoding: 'utf8',
    });
    expect(listing).not.toContain('keys.json');
    const inA = await trialWithOnly(a.database, 'kek-a', keyA);
    const expected = inA.byPurpose
      .filter((entry) => entry.readable > 0)
      .map((entry) => ({ purpose: entry.purpose, count: entry.readable }));
    expect(expected.length).toBeGreaterThan(0);
    await a.container.shutdown();
    containers.splice(containers.indexOf(a.container), 1);

    const keyB = randomBytes(32);
    const b = await installation('kek-b', keyB);
    const beforeB = await plaintexts(b.database, onlyKey('kek-b', keyB));

    // 1. Refused, with the right kinds and counts, no kit offered, nothing cut over.
    const refused = await upload(b, archivePath, BACKUP_PASSWORD);
    expect(refused.failureCode).toBe('recovery.candidate_secrets_unreadable');
    expect(refused.request.state).toBe('FAILED');
    expect(refused.request.restoreTest?.unreadableSecrets).toEqual(expected);
    expect(refused.request.restoreTest?.cutoverPermitted).toBe(false);
    expect(refused.request.restoreTest).not.toHaveProperty('canUploadKit');
    expect(await plaintexts(b.database, onlyKey('kek-b', keyB))).toEqual(beforeB);
    expect(refused.request.candidateDatabase ?? null).toBeNull();

    // 2. B holds A's key as a decrypt-only key a Recovery Kit imported before the kit was
    //    removed (seeded as the import stored it: wrapped under B's active key).
    await withDb(b.database, (client) =>
      client.query(
        `INSERT INTO installation_keys
           (id, key_id, fingerprint, wrapped_material, wrapped_under_key_id, source, imported_at)
         VALUES ($1, 'kek-a', $2, $3, 'kek-b', 'RECOVERY_KIT', now())`,
        [
          randomUUID(),
          kekFingerprint(keyA),
          wrapInstallationKey({
            keyId: 'kek-a',
            material: keyA,
            wrappingKeyId: 'kek-b',
            wrappingKey: keyB,
          }),
        ],
      ),
    );
    await b.container.installationKeyLoader.refresh();
    expect(b.container.keyring.importedKeys.get('kek-a')?.equals(keyA)).toBe(true);
    // The live installation still reads with it — but a restore does not.
    const again = await upload(b, archivePath, BACKUP_PASSWORD);
    expect(again.failureCode).toBe('recovery.candidate_secrets_unreadable');
    expect(again.request.restoreTest?.unreadableSecrets).toEqual(expected);
    expect(again.request.restoreTest?.cutoverPermitted).toBe(false);
    expect(await plaintexts(b.database, onlyKey('kek-b', keyB))).toEqual(beforeB);
    expect(again.request.candidateDatabase ?? null).toBeNull();
  }, 300_000);

  it('the trial reads only the database it is pointed at — the restored one — and never the live one', async () => {
    const keyB = randomBytes(32);
    const b = await installation('kek-b', keyB);
    const other = await installation('kek-other', randomBytes(32));
    const otherCount = (await trialWithOnly(other.database, 'kek-other', other.material))
      .readableTotal;
    const liveCount = (await trialWithOnly(b.database, 'kek-b', keyB)).readableTotal;
    expect(otherCount).toBeGreaterThan(0);

    // From B: the other installation's rows are all unreadable, B's own are not
    // counted at all — the trial saw exactly the other database's rows.
    const report = await b.container.recoveryKeyCoverage.trialDecrypt(other.database);
    expect(report.readableTotal).toBe(0);
    expect(report.unreadableTotal).toBe(otherCount);
    const otherIds = await withDb(other.database, async (client) =>
      (await client.query<{ id: string }>('SELECT id::text AS id FROM bot_instances')).rows.map(
        (r) => r.id,
      ),
    );
    const reportedBots = report.unreadable
      .filter((r) => r.purpose === 'bot_instance.token')
      .map((r) => r.entityId);
    expect(reportedBots.sort()).toEqual(otherIds.sort());
    expect(liveCount).toBeGreaterThan(0);

    // The live database is refused by name, before a connection is opened.
    await expect(b.container.recoveryKeyCoverage.trialDecrypt(b.database)).rejects.toThrow();
    await expect(
      b.container.recoveryKeyCoverage.rewrapUnderActiveKey(b.database),
    ).rejects.toThrow();
  }, 300_000);
});
