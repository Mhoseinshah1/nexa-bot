import { copyFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLATFORM_ERROR_CODES, type ActorContext } from '@nexa/contracts';
import { createContainer, type Container } from '../../apps/api/src/container';
import { runMigrations } from '../../apps/api/src/infrastructure/persistence/migrate';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { readArchiveHeader } from '../../apps/api/src/modules/platform/backup/infrastructure/archive';
import {
  FAST_KIT_KDF,
  sealRecoveryKit,
} from '../../apps/api/src/infrastructure/crypto/recovery-kit';
import { adminActorFor, createAdmin, tenantA, testConfig } from './harness';

/**
 * Bare-metal recovery with a Recovery Kit, end to end, against a real
 * PostgreSQL and the real cutover. ADR-0032; the owner's specification § 15.
 *
 * Two INSTALLATIONS, each with its own database and its own configured key:
 *
 *   A — the old server. Key `kek-a`. Takes a real backup (sealed under kek-a),
 *       holds bot tokens sealed under kek-a, and exports its Recovery Kit.
 *   B — the fresh install. Key `kek-b`, and nothing else. It is handed A's
 *       `.nxb`, A's kit and the kit's passphrase.
 *
 * What must be true at the end, each asserted:
 *
 *   - before the kit, B refuses A's archive as FOREIGN, and a wrong passphrase
 *     imports nothing;
 *   - after the kit, the archive verifies, restore-tests, confirms, and the
 *     executor cuts over to it for real;
 *   - the restored installation READS A's secrets (the kit's key came across the
 *     cutover, carried into the candidate);
 *   - and it still ENCRYPTS with kek-b: a new secret and a new backup are sealed
 *     under B's own key, never the imported one.
 *
 * Like `recovery-executor.test.ts`, each case builds THROWAWAY live databases,
 * because the cutover renames the database it runs against.
 */

const PASSPHRASE = 'the old server had a long passphrase';

describe('restoring another installation’s backup with its Recovery Kit', () => {
  let created: string[];
  const roots: string[] = [];
  const containers: Container[] = [];

  const kekA = randomBytes(32);
  const kekB = randomBytes(32);

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

  /** One "installation": its own database, work directories and configured key. */
  async function installation(
    keyId: string,
    material: Buffer,
    extraKeys = '',
  ): Promise<{ container: Container; database: string; workRoot: string; owner: ActorContext }> {
    const database = `nexa_kitlive_${randomBytes(6).toString('hex')}`;
    created.push(database);
    await maintenance(`CREATE DATABASE "${database}"`);
    const url = new URL(testConfig().DATABASE_URL);
    url.pathname = `/${database}`;
    await runMigrations(url.toString());

    const workRoot = await mkdtemp(join(tmpdir(), 'nexa-kit-backups-'));
    const recoveryRoot = await mkdtemp(join(tmpdir(), 'nexa-kit-recovery-'));
    roots.push(workRoot, recoveryRoot);
    const container = createContainer(
      testConfig({
        DATABASE_URL: url.toString(),
        BACKUP_WORK_DIR: workRoot,
        RECOVERY_WORK_DIR: recoveryRoot,
        SECRETS_KEYS: `${extraKeys}${keyId}:${material.toString('base64')}`,
        SECRETS_ACTIVE_KEY_ID: keyId,
      }),
      'recovery',
    );
    containers.push(container);
    await seed(container.database.db, container.cipher);
    container.setInstallationTenant(tenantA.tenantId);
    const owner = adminActorFor(
      await createAdmin(container, tenantA, {
        username: `owner-${keyId}`,
        password: 'the-owners-real-password',
        roleKeys: ['owner'],
      }),
    );
    return { container, database, workRoot, owner };
  }

  /** A real backup of `container`, and the path of its archive. */
  async function backupOf(container: Container, workRoot: string): Promise<string> {
    const outcome = await container.backup.run('MANUAL');
    expect(outcome.kind).toBe('COMPLETED');
    if (outcome.kind !== 'COMPLETED') throw new Error('unreachable');
    expect(outcome.run.state).toBe('SUCCEEDED');
    return join(workRoot, outcome.run.id, 'archive.nxb');
  }

  /** Uploads `archivePath` into `container` the way the HTTP upload would. */
  async function upload(container: Container, actor: ActorContext, archivePath: string) {
    const begun = await container.recoveryService.beginUpload(tenantA, actor, {
      clientFilename: 'old-server.nxb',
    });
    await copyFile(archivePath, begun.workspace.archivePath);
    const { size } = await stat(begun.workspace.archivePath);
    await container.recoveryService.completeUpload(tenantA, begun.request.id, {
      sizeBytes: size,
      archiveSha256: 'a'.repeat(64),
    });
    return container.recoveryService.verifyAndTest(tenantA, actor, begun.request.id);
  }

  /** Every bot token in `database`, as stored. */
  async function tokens(database: string) {
    return queryIn<{
      id: string;
      tenant_id: string;
      token_ciphertext: string;
      token_key_id: string;
    }>(
      database,
      'SELECT id, tenant_id, token_ciphertext, token_key_id FROM bot_instances ORDER BY id',
    );
  }

  beforeEach(() => {
    created = [];
  });

  afterEach(async () => {
    for (const container of containers.splice(0)) await container.shutdown().catch(() => undefined);
    // Only what THIS file created. Not a cluster-wide LIKE sweep: other suites
    // (and other agents' databases) may hold `nexa_drlive_*` (which is why these are `nexa_kitlive_*`) names right now.
    for (const name of new Set(created.filter((name) => name !== ''))) {
      await maintenance(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
    }
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it('restores .nxb + kit + passphrase on a fresh install, and keeps the new key active', async () => {
    // --- The OLD server --------------------------------------------------
    const a = await installation('kek-a', kekA);
    const oldTokens = await tokens(a.database);
    expect(oldTokens.length).toBeGreaterThan(0);
    expect(oldTokens.every((row) => row.token_key_id === 'kek-a')).toBe(true);
    const oldPlaintexts = oldTokens.map((row) =>
      a.container.cipher.decrypt(
        { keyId: row.token_key_id, ciphertext: row.token_ciphertext },
        { purpose: 'bot_instance.token', tenantId: row.tenant_id, entityId: row.id },
      ),
    );
    const archivePath = await backupOf(a.container, a.workRoot);
    expect((await readArchiveHeader(archivePath)).header.keyId).toBe('kek-a');
    const kit = await a.container.installationKeys.exportKit(
      tenantA,
      a.owner,
      {
        accountPassword: 'the-owners-real-password',
        passphrase: PASSPHRASE,
        passphraseConfirmation: PASSPHRASE,
      },
      { ip: null },
    );
    expect(kit.keyCount).toBe(1);
    // The old server is gone. Only the archive and the kit survive it.
    await a.container.shutdown();
    containers.splice(containers.indexOf(a.container), 1);

    // --- The FRESH install -----------------------------------------------
    const b = await installation('kek-b', kekB);

    // 1. Without the kit, the archive is foreign — the defect being fixed.
    const foreign = await upload(b.container, b.owner, archivePath);
    expect(foreign.failureCode).toBe('recovery.archive_foreign_key');

    // 2. A wrong passphrase imports nothing.
    await expect(
      b.container.installationKeys.importKit(tenantA, b.owner, {
        kit: kit.bytes.toString('base64'),
        passphrase: 'not the passphrase it was sealed with',
        idempotencyKey: 'kit-import-wrong-1',
      }),
    ).rejects.toMatchObject({ code: PLATFORM_ERROR_CODES.RECOVERY_KIT_AUTH_FAILED });
    expect(await b.container.installationKeyRepository.all()).toHaveLength(0);

    // 3. The right one imports kek-a, DECRYPT-ONLY.
    const imported = await b.container.installationKeys.importKit(tenantA, b.owner, {
      kit: kit.bytes.toString('base64'),
      passphrase: PASSPHRASE,
      idempotencyKey: 'kit-import-right-1',
    });
    expect(imported.imported.map((k) => k.keyId)).toEqual(['kek-a']);
    expect(b.container.keyring.activeKeyId).toBe('kek-b');
    const listed = await b.container.installationKeys.list(tenantA, b.owner);
    expect(listed.find((k) => k.keyId === 'kek-a')).toMatchObject({
      origin: 'IMPORTED',
      encrypts: false,
      available: true,
    });
    expect(listed.filter((k) => k.encrypts).map((k) => k.keyId)).toEqual(['kek-b']);

    // 4. The same archive now verifies and restore-tests.
    const tested = await upload(b.container, b.owner, archivePath);
    expect(tested.failureCode).toBeNull();
    expect(tested.request.state).toBe('RESTORE_TEST_PASSED');

    // 5. Confirmed, and executed for real: two renames.
    const confirmed = await b.container.recoveryService.confirm(
      tenantA,
      b.owner,
      tested.request.id,
      {
        phrase: 'RESTORE NEXA',
        artifactChecksum: tested.request.artifactChecksum ?? '',
      },
    );
    expect(confirmed.state).toBe('RESTORE_REQUESTED');
    await b.container.recoveryExecutor.tick();
    const row = await b.container.recoveryRequests.byIdUnscoped(tested.request.id);
    expect(row?.failureCode ?? null).toBeNull();
    expect(row?.state).toBe('SUCCEEDED');
    created.push(row?.displacedDatabase ?? '');

    // --- After the cutover ------------------------------------------------
    // B's live database IS A's data now: A's tokens, sealed under kek-a.
    const restored = await tokens(b.database);
    expect(restored.map((r) => r.token_ciphertext)).toEqual(
      oldTokens.map((r) => r.token_ciphertext),
    );

    // The kit's key CAME ACROSS the cutover. It was carried into the candidate,
    // so a fresh load from the restored database still holds it…
    const keysInRestored = await queryIn<{ key_id: string; wrapped_under_key_id: string }>(
      b.database,
      'SELECT key_id, wrapped_under_key_id FROM installation_keys',
    );
    expect(keysInRestored).toEqual([{ key_id: 'kek-a', wrapped_under_key_id: 'kek-b' }]);
    b.container.keyring.replaceImported(new Map());
    await b.container.installationKeyLoader.refresh();

    // …so the restored installation reads A's secrets…
    const readBack = restored.map((r) =>
      b.container.cipher.decrypt(
        { keyId: r.token_key_id, ciphertext: r.token_ciphertext },
        { purpose: 'bot_instance.token', tenantId: r.tenant_id, entityId: r.id },
      ),
    );
    expect(readBack).toEqual(oldPlaintexts);

    // …and still ENCRYPTS with its own key. The historical key never became active.
    expect(b.container.keyring.activeKeyId).toBe('kek-b');
    const fresh = b.container.cipher.encrypt('a secret written after the restore', {
      purpose: 'bot_instance.token',
      tenantId: tenantA.tenantId,
      entityId: randomUUID(),
    });
    expect(fresh.keyId).toBe('kek-b');
    // An archive sealed now goes through the SAME archiver the pipeline uses.
    // (Not a whole backup run: the restored database carries A's own backup row
    // as it was mid-dump — RUNNING — which holds the backup lock until its lease
    // goes stale. That is the backup pipeline's lease rule, not a key question.)
    const scratch = await mkdtemp(join(tmpdir(), 'nexa-kit-seal-'));
    roots.push(scratch);
    await writeFile(join(scratch, 'dump'), Buffer.from('PGDMP-not-really'));
    const sealed = await b.container.backupArchiver.seal({
      dumpPath: join(scratch, 'dump'),
      archivePath: join(scratch, 'archive.nxb'),
      manifest: {
        manifestVersion: 1,
        backupId: randomUUID(),
        installationId: 'b',
        createdAt: new Date().toISOString(),
        databaseName: b.database,
        postgresVersion: '16',
        pgDumpVersion: 'pg_dump 16',
        dumpFormat: 'custom',
        dumpBytes: 16,
        checksumAlgorithm: 'sha256',
        checksum: 'c'.repeat(64),
        exclusions: [],
      } as never,
    });
    expect(sealed.keyId).toBe('kek-b');
    expect((await readArchiveHeader(join(scratch, 'archive.nxb'))).header.keyId).toBe('kek-b');
  });

  it('refuses before confirmation when the restored secrets need a key the kit lacks', async () => {
    // The old server rotated once: its bot tokens are still under `kek-old`, its
    // archives are sealed under `kek-a`. A kit holding ONLY kek-a opens the
    // archive — and leaves every restored credential unreadable.
    const kekOld = randomBytes(32);
    const a = await installation('kek-old', kekOld);
    // Rotate: same database, a container whose ACTIVE key is kek-a.
    const url = new URL(testConfig().DATABASE_URL);
    url.pathname = `/${a.database}`;
    const rotated = createContainer(
      testConfig({
        DATABASE_URL: url.toString(),
        BACKUP_WORK_DIR: a.workRoot,
        RECOVERY_WORK_DIR: a.workRoot,
        SECRETS_KEYS: `kek-old:${kekOld.toString('base64')},kek-a:${kekA.toString('base64')}`,
        SECRETS_ACTIVE_KEY_ID: 'kek-a',
      }),
      'worker',
    );
    containers.push(rotated);
    rotated.setInstallationTenant(tenantA.tenantId);
    const archivePath = await backupOf(rotated, a.workRoot);
    expect((await readArchiveHeader(archivePath)).header.keyId).toBe('kek-a');

    const partialKit = await sealRecoveryKit({
      keys: [{ keyId: 'kek-a', material: kekA }],
      passphrase: PASSPHRASE,
      profile: FAST_KIT_KDF,
      kitId: randomUUID(),
      createdAt: new Date(),
    });

    const b = await installation('kek-b', kekB);
    await b.container.installationKeys.importKit(tenantA, b.owner, {
      kit: partialKit.toString('base64'),
      passphrase: PASSPHRASE,
      idempotencyKey: 'kit-import-partial-1',
    });
    const tested = await upload(b.container, b.owner, archivePath);
    // The archive DECRYPTED — so this is not a foreign archive — and the scratch
    // restore found secrets under a key nobody here holds.
    expect(tested.request.verification?.decrypted).toBe(true);
    expect(tested.failureCode).toBe('recovery.candidate_keys_missing');
    expect(tested.request.state).toBe('FAILED');
  });
});
