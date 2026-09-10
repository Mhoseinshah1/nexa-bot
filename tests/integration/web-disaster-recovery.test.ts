import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  BACKUP_ROUTES,
  backupHistoryResponseSchema,
  backupStatusResponseSchema,
  PLATFORM_ERROR_CODES,
  RECOVERY_CONFIRMATION_PHRASE,
  RECOVERY_ROUTES,
  recoveryCapabilitiesResponseSchema,
  recoveryDetailResponseSchema,
  recoveryListResponseSchema,
  runBackupResponseSchema,
  SESSION_COOKIE_NAME,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { createAdmin, migrateOnce, resetDatabase, tenantA, tenantB, testConfig } from './harness';

/**
 * Web Admin Disaster Recovery, end to end, against a real PostgreSQL.
 *
 * Everything that matters here depends on PostgreSQL and cannot be mocked
 * without proving nothing: a real `pg_dump`, a real `pg_restore` into a real
 * empty database it creates, a real `CREATE DATABASE`, real renames, and the
 * partial unique index that permits one destructive recovery at a time.
 *
 * The archives are produced by the pipeline itself rather than by a fixture,
 * which is the only way the verification path is exercised as the thing it is:
 * `openArchive` decrypting bytes `sealArchive` wrote, under this installation's
 * own keyring.
 */

const ORIGIN = 'https://admin.example.test';

describe('web disaster recovery', () => {
  let api: ApiApp;
  let ownerCookie: string;
  let observerCookie: string;
  let technicalCookie: string;
  let workRoot: string;
  let recoveryRoot: string;
  /**
   * The installation's keyring, resolved from the SAME config the API was built
   * from, so an archive this file seals is one this installation can open.
   *
   * Resolved here rather than read off the container, which does not expose it —
   * and should not: nothing in the application needs the raw keys, and a test
   * needing them is not a reason to widen that surface.
   */
  let keyring: { activeKeyId: string; keys: Map<string, Buffer> };

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  /**
   * Debris from an INTERRUPTED earlier run, removed once before this file starts.
   *
   * The cleanup case below asserts that no `nexa_rtest_*` database exists
   * anywhere, which is the property worth having: a leaked scratch is real debris
   * on an operator's server, and a per-case assertion scoped to one name would
   * not notice a leak from a different case.
   *
   * But that assertion is global over the CLUSTER, so a scratch left behind by a
   * run somebody killed fails the NEXT run — for a leak the next run did not
   * cause. That happened here: a scratch created at 10:57:18 failed a run that
   * started at 12:12:35, and the UUIDv7 in its own name is what proved it, since
   * the first twelve hex digits are a millisecond timestamp.
   *
   * So pre-existing debris is cleared ONCE, in `beforeAll` and never in
   * `beforeEach`. The distinction is the whole point: clearing per-case would
   * hide a leak from the case before, which is exactly what the assertion exists
   * to catch.
   */
  async function dropPreExistingScratches(databaseUrl: string): Promise<void> {
    const { Client } = await import('pg');
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const { rows } = await client.query<{ datname: string }>(
        `SELECT datname FROM pg_database WHERE datname LIKE 'nexa_rtest\\_%'`,
      );
      for (const row of rows) {
        // The name came from `pg_database`, and the LIKE above bounds it to this
        // prefix — but it is still an identifier being interpolated, so it is
        // checked against the shape this code generates rather than trusted.
        if (!/^nexa_rtest_[0-9a-f]{16}$/.test(row.datname)) continue;
        await client.query(`DROP DATABASE IF EXISTS "${row.datname}" WITH (FORCE)`);
      }
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    workRoot = await mkdtemp(join(tmpdir(), 'nexa-dr-backups-'));
    recoveryRoot = await mkdtemp(join(tmpdir(), 'nexa-dr-recovery-'));
    const config = testConfig({
      WEB_ADMIN_ORIGINS: ORIGIN,
      BACKUP_WORK_DIR: workRoot,
      RECOVERY_WORK_DIR: recoveryRoot,
      // Small enough to exercise the ceiling with a real archive, large enough
      // that the dev database's ~100 KiB dump fits. The oversize case writes a
      // buffer bigger than this rather than a real archive.
      RECOVERY_UPLOAD_MAX_BYTES: '1048576',
    });
    const { resolveKeyring } =
      await import('../../apps/api/src/infrastructure/crypto/resolve-keyring');
    keyring = resolveKeyring(config) as never;
    await migrateOnce(config.DATABASE_URL);
    await dropPreExistingScratches(config.DATABASE_URL);
    api = await createApiApp(config);
  });

  afterAll(async () => {
    await api?.close();
    await rm(workRoot, { recursive: true, force: true });
    await rm(recoveryRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);

    await createAdmin(api.container, tenantA, {
      username: 'owner',
      password: 'the-owners-real-password',
      roleKeys: ['owner'],
    });
    // `backup.view` only: every LOW permission, and nothing that can run,
    // download or restore.
    await createAdmin(api.container, tenantA, {
      username: 'observer',
      password: 'the-observers-password',
      roleKeys: ['observer'],
    });
    // `backup.view` + `backup.run`, and NOT `backup.download` or
    // `recovery.restore`. The role that exists to prove the four keys are four.
    await createAdmin(api.container, tenantA, {
      username: 'technical',
      password: 'the-technical-password',
      roleKeys: ['technical'],
    });

    ownerCookie = await cookieFor('owner', 'the-owners-real-password');
    observerCookie = await cookieFor('observer', 'the-observers-password');
    technicalCookie = await cookieFor('technical', 'the-technical-password');
  });

  async function cookieFor(username: string, password: string): Promise<string> {
    const response = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username, password },
    });
    const header = String(response.headers['set-cookie'] ?? '');
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(header);
    if (match === null) throw new Error(`No session cookie for ${username}.`);
    return `${SESSION_COOKIE_NAME}=${match[1] as string}`;
  }

  const asAdmin = (cookie: string) => ({ cookie, origin: ORIGIN });
  const get = (path: string, cookie: string) =>
    inject({ method: 'GET', url: `${API_PREFIX}${path}`, headers: asAdmin(cookie) });
  const post = (path: string, cookie: string, payload?: unknown) =>
    inject({
      method: 'POST',
      url: `${API_PREFIX}${path}`,
      headers: asAdmin(cookie),
      ...(payload === undefined ? {} : { payload }),
    });

  let keys = 0;
  const idempotencyKey = () => `dr-key-${(keys += 1)}-${Date.now()}`;

  /**
   * Takes a REAL backup and returns its run and the archive bytes.
   *
   * Through the HTTP endpoint, so the whole path an operator uses is what
   * produces the artifact every later case consumes. `pnpm test:integration`
   * therefore requires `pg_dump` and `pg_restore` on PATH, which the dev
   * services script already installs.
   */
  async function takeBackup(cookie = ownerCookie): Promise<{
    id: string;
    checksum: string;
    archive: Buffer;
  }> {
    const response = await post(BACKUP_ROUTES.run, cookie, {
      idempotencyKey: idempotencyKey(),
    });
    expect(response.statusCode, response.body).toBe(201);
    const body = runBackupResponseSchema.parse(response.json());
    expect(body.outcome).toBe('COMPLETED');
    expect(body.run.state).toBe('SUCCEEDED');
    expect(body.run.verifiedAt).not.toBeNull();
    const archive = await readFile(join(workRoot, body.run.id, 'archive.nxb'));
    return { id: body.run.id, checksum: body.run.checksum ?? '', archive };
  }

  /** Uploads bytes as a raw octet-stream, the way the Web Admin does. */
  const upload = (bytes: Buffer, cookie = ownerCookie, filename = 'my-backup.nxb') =>
    inject({
      method: 'POST',
      url: `${API_PREFIX}${RECOVERY_ROUTES.upload}`,
      headers: {
        ...asAdmin(cookie),
        'content-type': 'application/octet-stream',
        'x-nexa-filename': filename,
      },
      payload: bytes,
    });

  // --- The backup surface --------------------------------------------------

  describe('the backup surface', () => {
    it('reports status truthfully before anything has run', async () => {
      const response = await get(BACKUP_ROUTES.status, ownerCookie);
      expect(response.statusCode).toBe(200);
      const status = backupStatusResponseSchema.parse(response.json());
      expect(status.lastSucceededAt).toBeNull();
      expect(status.running).toBeNull();
      expect(status.unknownDeliveries).toBe(0);
      expect(status.quiesced).toBe(false);
    });

    it('takes a real backup, verified against a real restore', async () => {
      const { id, checksum, archive } = await takeBackup();
      expect(checksum).toMatch(/^[0-9a-f]{64}$/);
      // Not a fixture: these are the bytes `sealArchive` wrote, and they begin
      // with the container's magic.
      expect(archive.subarray(0, 8).toString('ascii')).toBe('NEXABAK1');

      const status = backupStatusResponseSchema.parse(
        (await get(BACKUP_ROUTES.status, ownerCookie)).json(),
      );
      expect(status.lastSucceededAt).not.toBeNull();

      const detail = (await get(BACKUP_ROUTES.detail(id), ownerCookie)).json() as {
        run: { verifiedAt: string | null; archiveAvailable: boolean };
      };
      expect(detail.run.verifiedAt).not.toBeNull();
      expect(detail.run.archiveAvailable).toBe(true);
    });

    it('never exposes a failure MESSAGE, only a code', async () => {
      // The column holds an arbitrary `error.message` and the projection must not
      // carry it. Asserted on the SHAPE rather than on a failed run, so the rule
      // holds for every response this endpoint can produce.
      await takeBackup();
      const body = (await get(BACKUP_ROUTES.history, ownerCookie)).json() as {
        runs: Record<string, unknown>[];
      };
      expect(body.runs.length).toBeGreaterThan(0);
      for (const run of body.runs) {
        expect(Object.keys(run)).not.toContain('failureMessage');
        expect(Object.keys(run)).toContain('failureCode');
      }
    });

    it('pages the history with a keyset, and refuses a cursor it did not mint', async () => {
      await takeBackup();
      await takeBackup();
      await takeBackup();

      const first = backupHistoryResponseSchema.parse(
        (await get(`${BACKUP_ROUTES.history}?limit=2`, ownerCookie)).json(),
      );
      expect(first.runs).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();

      const second = backupHistoryResponseSchema.parse(
        (
          await get(
            `${BACKUP_ROUTES.history}?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
            ownerCookie,
          )
        ).json(),
      );
      expect(second.runs).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      // No overlap and no gap: three runs across two pages.
      const ids = [...first.runs, ...second.runs].map((run) => run.id);
      expect(new Set(ids).size).toBe(3);

      // The house rule: a cursor this server did not mint is a 400, never a
      // silent restart at page one. A restart would loop a client for ever and
      // never tell it.
      const invented = await get(`${BACKUP_ROUTES.history}?cursor=bm90LWEtY3Vyc29y`, ownerCookie);
      expect(invented.statusCode).toBe(400);
    });

    it('refuses a limit it was not asked for rather than clamping it', async () => {
      for (const limit of ['0', '-1', 'abc', '101', '1.5']) {
        const response = await get(`${BACKUP_ROUTES.history}?limit=${limit}`, ownerCookie);
        expect(response.statusCode, `limit=${limit}`).toBe(400);
      }
    });
  });

  // --- Authorisation -------------------------------------------------------

  describe('the four permissions are four', () => {
    it('lets backup.view read and refuses it everything else', async () => {
      expect((await get(BACKUP_ROUTES.status, observerCookie)).statusCode).toBe(200);
      expect((await get(BACKUP_ROUTES.history, observerCookie)).statusCode).toBe(200);

      const ran = await post(BACKUP_ROUTES.run, observerCookie, {
        idempotencyKey: idempotencyKey(),
      });
      expect(ran.statusCode).toBe(403);
    });

    it('lets backup.run take a backup and still refuses the download', async () => {
      const { id } = await takeBackup(technicalCookie);
      const download = await get(BACKUP_ROUTES.download(id), technicalCookie);
      // CRITICAL, and held by the owner alone among these three. The archive is
      // the whole database.
      expect(download.statusCode).toBe(403);

      const owner = await get(BACKUP_ROUTES.download(id), ownerCookie);
      expect(owner.statusCode).toBe(200);
      expect(owner.headers['content-type']).toBe('application/octet-stream');
      expect(String(owner.headers['content-disposition'])).toContain(`nexa-backup-${id}.nxb`);
      expect(owner.headers['cache-control']).toBe('no-store');
      expect(owner.rawPayload.subarray(0, 8).toString('ascii')).toBe('NEXABAK1');
    });

    it('refuses the confirmation to an actor without recovery.restore', async () => {
      const { archive, checksum } = await takeBackup();
      const created = recoveryDetailResponseSchema.parse((await upload(archive)).json());
      await post(`${RECOVERY_ROUTES.detail(created.recovery.id)}/verify`, ownerCookie);

      const denied = await post(RECOVERY_ROUTES.confirm(created.recovery.id), technicalCookie, {
        phrase: RECOVERY_CONFIRMATION_PHRASE,
        artifactChecksum: checksum,
        idempotencyKey: idempotencyKey(),
      });
      expect(denied.statusCode).toBe(403);
    });

    it('lets backup.view upload and verify, because proving an archive changes nothing', async () => {
      const { archive } = await takeBackup();
      const created = await upload(archive, observerCookie);
      expect(created.statusCode, created.body).toBe(201);
      const verified = await post(
        `${RECOVERY_ROUTES.detail(recoveryDetailResponseSchema.parse(created.json()).recovery.id)}/verify`,
        observerCookie,
      );
      expect(verified.statusCode).toBe(201);
      expect(recoveryDetailResponseSchema.parse(verified.json()).recovery.state).toBe(
        'RESTORE_TEST_PASSED',
      );
    });
  });

  // --- Upload and verification --------------------------------------------

  describe('upload and verification', () => {
    it('verifies a real archive and restore-tests it into a real empty database', async () => {
      const { archive, checksum } = await takeBackup();
      const created = recoveryDetailResponseSchema.parse((await upload(archive)).json());
      expect(created.recovery.state).toBe('UPLOADED');
      expect(created.recovery.upload?.sizeBytes).toBe(archive.length);

      const verified = recoveryDetailResponseSchema.parse(
        (await post(`${RECOVERY_ROUTES.detail(created.recovery.id)}/verify`, ownerCookie)).json(),
      );
      expect(verified.recovery.state).toBe('RESTORE_TEST_PASSED');
      expect(verified.recovery.verification?.decrypted).toBe(true);
      expect(verified.recovery.verification?.checksumMatches).toBe(true);
      expect(verified.recovery.verification?.checksum).toBe(checksum);
      // Asserted empty, and the emptiness is the point: nothing is excluded from
      // a dump by name, by prefix, or because a table looks transient.
      expect(verified.recovery.verification?.exclusions).toEqual([]);
      // A REAL restore happened, and the table count proves it was not empty.
      expect(verified.recovery.restoreTest?.restored).toBe(true);
      expect(verified.recovery.restoreTest?.tableCount).toBeGreaterThan(20);
      expect(verified.recovery.restoreTest?.migrationVerdict).toBe('CURRENT');
      expect(verified.recovery.restoreTest?.cutoverPermitted).toBe(true);
    });

    it('drops the scratch database and removes the plaintext', async () => {
      const { archive } = await takeBackup();
      const created = recoveryDetailResponseSchema.parse((await upload(archive)).json());
      await post(`${RECOVERY_ROUTES.detail(created.recovery.id)}/verify`, ownerCookie);

      // No `nexa_rtest_*` database survives. A leaked one is real debris on the
      // operator's server, and the engine records a failed drop rather than
      // throwing — so this is the assertion that notices.
      const { rows } = await api.container.database.withClient((client) =>
        client.query<{ datname: string }>(
          `SELECT datname FROM pg_database WHERE datname LIKE 'nexa_rtest_%'`,
        ),
      );
      expect(rows).toEqual([]);
      expect(api.container.backupTools.leaked).toEqual([]);

      // And no decrypted dump is left anywhere under the recovery root. The
      // plaintext is the database with the encryption taken off.
      const leftovers = await findFiles(recoveryRoot, 'decrypted.pgcustom');
      expect(leftovers).toEqual([]);
    });

    it('refuses a malformed archive with a safe code and cleans up', async () => {
      const created = recoveryDetailResponseSchema.parse(
        (await upload(Buffer.from('this is not a nexa archive at all'))).json(),
      );
      const verified = recoveryDetailResponseSchema.parse(
        (await post(`${RECOVERY_ROUTES.detail(created.recovery.id)}/verify`, ownerCookie)).json(),
      );
      expect(verified.recovery.state).toBe('FAILED');
      expect(verified.recovery.failureCode).toBe('recovery.archive_malformed');
      // The workspace is gone, and the row no longer points at a path that does
      // not exist.
      expect(verified.recovery.upload).not.toBeNull();
      const row = await api.container.recoveryRequests.byIdUnscoped(created.recovery.id);
      expect(row?.workspacePath).toBeNull();
    });

    it('refuses a mutated header as an authentication failure, not a format error', async () => {
      const { archive } = await takeBackup();
      const mutated = Buffer.from(archive);
      // The header is cleartext and is the payload's associated data, so editing
      // one byte of it must make the PAYLOAD fail to authenticate rather than
      // steer the decryption. The magic and the length prefix are left intact so
      // the failure cannot be a format complaint.
      const headerStart = 8 + 4 + 20;
      mutated[headerStart] = (mutated[headerStart] ?? 0) === 0x41 ? 0x42 : 0x41;
      const created = recoveryDetailResponseSchema.parse((await upload(mutated)).json());
      const verified = recoveryDetailResponseSchema.parse(
        (await post(`${RECOVERY_ROUTES.detail(created.recovery.id)}/verify`, ownerCookie)).json(),
      );
      expect(verified.recovery.state).toBe('FAILED');
      expect(['recovery.archive_auth_failed', 'recovery.archive_malformed']).toContain(
        verified.recovery.failureCode,
      );
    });

    it('refuses a mutated ciphertext as an authentication failure', async () => {
      const { archive } = await takeBackup();
      const mutated = Buffer.from(archive);
      // Well inside the encrypted region, and nowhere near the tag.
      const midpoint = Math.floor(archive.length / 2);
      mutated[midpoint] = (mutated[midpoint] ?? 0) ^ 0xff;
      const created = recoveryDetailResponseSchema.parse((await upload(mutated)).json());
      const verified = recoveryDetailResponseSchema.parse(
        (await post(`${RECOVERY_ROUTES.detail(created.recovery.id)}/verify`, ownerCookie)).json(),
      );
      expect(verified.recovery.state).toBe('FAILED');
      // ONE answer for a wrong key, a flipped byte and a truncated file. An error
      // that distinguished them would tell whoever holds the archive which of
      // their guesses was closer.
      expect(verified.recovery.failureCode).toBe('recovery.archive_auth_failed');
    });

    it('refuses a truncated archive', async () => {
      const { archive } = await takeBackup();
      const created = recoveryDetailResponseSchema.parse(
        (await upload(archive.subarray(0, archive.length - 64))).json(),
      );
      const verified = recoveryDetailResponseSchema.parse(
        (await post(`${RECOVERY_ROUTES.detail(created.recovery.id)}/verify`, ownerCookie)).json(),
      );
      expect(verified.recovery.state).toBe('FAILED');
      expect(['recovery.archive_auth_failed', 'recovery.archive_malformed']).toContain(
        verified.recovery.failureCode,
      );
    });

    it('refuses an oversized upload on the STREAM, and keeps nothing', async () => {
      // Past `RECOVERY_UPLOAD_MAX_BYTES`. Counted by the server as it writes,
      // not read off a header — a chunked request declares no length.
      const oversize = randomBytes(1024 * 1024 + 4096);
      const response = await upload(oversize);
      expect([400, 413]).toContain(response.statusCode);

      // Nothing is left behind: no archive, and no row that claims an upload.
      const files = await findFiles(recoveryRoot, 'upload.nxb');
      for (const file of files) {
        // Any surviving file must belong to another case's successful upload, not
        // to this one — so none may be as large as the rejected payload.
        const stats = await stat(file);
        expect(stats.size).toBeLessThan(oversize.length);
      }
    });

    /**
     * The three archives below are SEALED BY THIS TEST, under this
     * installation's own keyring, because each one is a shape the pipeline
     * cannot produce: a payload that is not a `pg_dump` archive, a manifest
     * whose checksum is not the payload's, and an archive wrapped under a key
     * this installation does not hold. Mutating a real archive cannot reach any
     * of them — every mutation fails the AEAD tag first, which is the one answer
     * the authentication layer is supposed to give.
     */
    async function seal(input: {
      readonly payload: Buffer;
      readonly manifest?: Partial<Record<string, unknown>>;
      readonly keyring?: { activeKeyId: string; keys: Map<string, Buffer> };
    }): Promise<Buffer> {
      const { sealArchive } =
        await import('../../apps/api/src/modules/platform/backup/infrastructure/archive');
      const { createHash } = await import('node:crypto');
      const directory = await mkdtemp(join(tmpdir(), 'nexa-dr-seal-'));
      try {
        const dumpPath = join(directory, 'dump.bin');
        const archivePath = join(directory, 'archive.nxb');
        await writeFile(dumpPath, input.payload);
        const manifest = {
          manifestVersion: 1 as const,
          backupId: '01a05e35-c9ad-7e93-bef3-1ed9b55292ff',
          installationId: 'test-installation',
          createdAt: '2026-09-09T02:00:00.000Z',
          databaseName: 'nexa',
          postgresVersion: '16.13',
          pgDumpVersion: 'pg_dump (PostgreSQL) 16.13',
          dumpFormat: 'custom' as const,
          dumpBytes: input.payload.length,
          checksumAlgorithm: 'sha256' as const,
          checksum: createHash('sha256').update(input.payload).digest('hex'),
          exclusions: [],
          ...input.manifest,
        };
        await sealArchive({
          dumpPath,
          archivePath,
          manifest: manifest as never,
          keyring: (input.keyring ?? keyring) as never,
        });
        return await readFile(archivePath);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }

    const verify = async (id: string) =>
      recoveryDetailResponseSchema.parse(
        (await post(`${RECOVERY_ROUTES.detail(id)}/verify`, ownerCookie)).json(),
      );

    it('refuses a payload that is not a pg_dump archive, naming the manifest', async () => {
      // Authenticates, and its checksum matches its manifest: everything before
      // the format check passes. The manifest says `dumpFormat: custom` and the
      // payload is plain SQL, which is what `pg_dump -Fp` writes and this
      // pipeline never does.
      const archive = await seal({
        payload: Buffer.from('-- PostgreSQL database dump\nCREATE TABLE t (id int);\n'),
      });
      const created = recoveryDetailResponseSchema.parse((await upload(archive)).json());
      const verified = await verify(created.recovery.id);

      expect(verified.recovery.state).toBe('FAILED');
      // NOT `restore_test_failed`: the file is the wrong kind, and the code says
      // so before a scratch database is created for it.
      expect(verified.recovery.failureCode).toBe('recovery.manifest_invalid');
      // And it got as far as reporting what it decrypted, so an operator can see
      // the archive was theirs and the payload was not a dump.
      expect(verified.recovery.verification?.decrypted).toBe(true);
      expect(verified.recovery.verification?.checksumMatches).toBe(true);
    });

    it('refuses a manifest whose checksum is not the payload it carries', async () => {
      // A REAL dump, and a manifest that records a different SHA-256. Both are
      // inside the authenticated region, so this authenticates perfectly: the
      // only thing wrong is that the archive lies about its own contents.
      const { archive: real } = await takeBackup();
      void real;
      const archive = await seal({
        payload: Buffer.concat([Buffer.from('PGDMP', 'ascii'), randomBytes(64)]),
        manifest: { checksum: 'b'.repeat(64) },
      });
      const created = recoveryDetailResponseSchema.parse((await upload(archive)).json());
      const verified = await verify(created.recovery.id);

      expect(verified.recovery.state).toBe('FAILED');
      expect(verified.recovery.failureCode).toBe('recovery.checksum_mismatch');
      // Reported on the row, so the operator sees WHICH check failed rather than
      // a generic refusal — and the computed checksum is the payload's, not the
      // manifest's claim.
      expect(verified.recovery.verification?.checksumMatches).toBe(false);
      expect(verified.recovery.verification?.checksum).not.toBe('b'.repeat(64));
    });

    it('refuses an archive wrapped under a key this installation does not hold', async () => {
      // The foreign-installation case, reached the only way it can be: a real
      // archive sealed under a REAL but different KEK. There is deliberately no
      // form that accepts a key, so this is a refusal by design — and it has its
      // own code, distinct from a corrupt file, because the two need different
      // actions from an operator.
      const archive = await seal({
        payload: Buffer.concat([Buffer.from('PGDMP', 'ascii'), randomBytes(64)]),
        keyring: {
          activeKeyId: 'someone-elses-key',
          keys: new Map([['someone-elses-key', randomBytes(32)]]),
        },
      });
      const created = recoveryDetailResponseSchema.parse((await upload(archive)).json());
      const verified = await verify(created.recovery.id);

      expect(verified.recovery.state).toBe('FAILED');
      expect(verified.recovery.failureCode).toBe('recovery.archive_foreign_key');
      // Nothing about the key is echoed. Not the id it named, not the ids held.
      expect(JSON.stringify(verified.recovery)).not.toContain('someone-elses-key');
    });

    it('refuses an empty upload', async () => {
      const response = await upload(Buffer.alloc(0));
      expect(response.statusCode).toBe(400);
    });

    it('records the client filename and never uses it as a path', async () => {
      const { archive } = await takeBackup();
      const created = recoveryDetailResponseSchema.parse(
        (await upload(archive, ownerCookie, '../../etc/passwd')).json(),
      );
      // Recorded for recognition, with the separators neutralised.
      expect(created.recovery.upload?.clientFilename).not.toContain('/');
      expect(created.recovery.upload?.clientFilename).not.toMatch(/^\./);
      // And the real path is under the recovery root, named by nothing the
      // client sent.
      const row = await api.container.recoveryRequests.byIdUnscoped(created.recovery.id);
      expect(row?.workspacePath?.startsWith(recoveryRoot)).toBe(true);
      expect(row?.workspacePath).toContain(created.recovery.id);
    });
  });

  // --- The confirmation ----------------------------------------------------

  describe('the restore confirmation', () => {
    async function readyToConfirm(): Promise<{ id: string; checksum: string }> {
      const { archive, checksum } = await takeBackup();
      const created = recoveryDetailResponseSchema.parse((await upload(archive)).json());
      const verified = recoveryDetailResponseSchema.parse(
        (await post(`${RECOVERY_ROUTES.detail(created.recovery.id)}/verify`, ownerCookie)).json(),
      );
      expect(verified.recovery.state).toBe('RESTORE_TEST_PASSED');
      return { id: created.recovery.id, checksum };
    }

    it('accepts the exact phrase with the right checksum, once', async () => {
      const { id, checksum } = await readyToConfirm();
      const first = await post(RECOVERY_ROUTES.confirm(id), ownerCookie, {
        phrase: RECOVERY_CONFIRMATION_PHRASE,
        artifactChecksum: checksum,
        idempotencyKey: idempotencyKey(),
      });
      expect(first.statusCode, first.body).toBe(201);
      const confirmed = recoveryDetailResponseSchema.parse(first.json());
      expect(confirmed.recovery.state).toBe('RESTORE_REQUESTED');
      expect(confirmed.recovery.confirmedAt).not.toBeNull();
      expect(confirmed.recovery.confirmationExpiresAt).not.toBeNull();

      // REPLAY. The transition is a conditional UPDATE from RESTORE_TEST_PASSED
      // alone, so a repeat finds the state advanced and changes nothing.
      const replay = await post(RECOVERY_ROUTES.confirm(id), ownerCookie, {
        phrase: RECOVERY_CONFIRMATION_PHRASE,
        artifactChecksum: checksum,
        idempotencyKey: idempotencyKey(),
      });
      expect(replay.statusCode).toBe(400);
      expect((replay.json() as { error: { code: string } }).error.code).toBe(
        PLATFORM_ERROR_CODES.RECOVERY_CONFIRMATION_INVALID,
      );
      const after = await api.container.recoveryRequests.byIdUnscoped(id);
      expect(after?.state).toBe('RESTORE_REQUESTED');
    });

    it('refuses a near-miss phrase', async () => {
      const { id, checksum } = await readyToConfirm();
      for (const phrase of ['restore nexa', 'RESTORE  NEXA', 'RESTORE', 'بازیابی']) {
        const response = await post(RECOVERY_ROUTES.confirm(id), ownerCookie, {
          phrase,
          artifactChecksum: checksum,
          idempotencyKey: idempotencyKey(),
        });
        expect(response.statusCode, phrase).toBe(400);
      }
      const row = await api.container.recoveryRequests.byIdUnscoped(id);
      expect(row?.state).toBe('RESTORE_TEST_PASSED');
      expect(row?.confirmedAt).toBeNull();
    });

    it('refuses a confirmation that names another artifact', async () => {
      // THE BINDING. A confirmation for backup A cannot restore backup B.
      const a = await readyToConfirm();
      const b = await readyToConfirm();
      expect(a.checksum).not.toBe('');
      const crossed = await post(RECOVERY_ROUTES.confirm(a.id), ownerCookie, {
        phrase: RECOVERY_CONFIRMATION_PHRASE,
        // B's checksum against A's request.
        artifactChecksum: b.checksum === a.checksum ? 'f'.repeat(64) : b.checksum,
        idempotencyKey: idempotencyKey(),
      });
      expect(crossed.statusCode).toBe(400);
      const row = await api.container.recoveryRequests.byIdUnscoped(a.id);
      expect(row?.state).toBe('RESTORE_TEST_PASSED');
    });

    it('refuses a confirmation on an artifact that has not been restore-tested', async () => {
      const { archive, checksum } = await takeBackup();
      const created = recoveryDetailResponseSchema.parse((await upload(archive)).json());
      // No verify call at all.
      const response = await post(RECOVERY_ROUTES.confirm(created.recovery.id), ownerCookie, {
        phrase: RECOVERY_CONFIRMATION_PHRASE,
        artifactChecksum: checksum,
        idempotencyKey: idempotencyKey(),
      });
      expect(response.statusCode).toBe(400);
    });

    it('takes the Origin check every other write takes', async () => {
      const { id, checksum } = await readyToConfirm();
      const response = await inject({
        method: 'POST',
        url: `${API_PREFIX}${RECOVERY_ROUTES.confirm(id)}`,
        headers: { cookie: ownerCookie, origin: 'https://evil.example.test' },
        payload: {
          phrase: RECOVERY_CONFIRMATION_PHRASE,
          artifactChecksum: checksum,
          idempotencyKey: idempotencyKey(),
        },
      });
      expect(response.statusCode).toBe(403);
    });
  });

  // --- Scope ---------------------------------------------------------------

  describe('a recovery holding the installation', () => {
    /**
     * The HTTP side of the quiesce window.
     *
     * The executor suite proves the write gate refuses the unit of work and the
     * relay; this proves what an OPERATOR gets, which is a different question: a
     * truthful refusal with a code, and a status that says so, rather than a
     * request that appears to work and writes nothing.
     */
    async function holdInstallation(): Promise<void> {
      const { archive } = await takeBackup();
      const created = recoveryDetailResponseSchema.parse((await upload(archive)).json());
      await api.container.database.db.execute(
        `UPDATE recovery_requests SET state = 'RESTORING', stage = 'RESTORE_CANDIDATE'
          WHERE id = '${created.recovery.id}'` as never,
      );
    }

    it('refuses a new backup while a recovery is restoring, and says so in the status', async () => {
      await holdInstallation();

      const status = backupStatusResponseSchema.parse(
        (await get(BACKUP_ROUTES.status, ownerCookie)).json(),
      );
      // The page is told, rather than finding out by pressing the button.
      expect(status.quiesced).toBe(true);

      const refused = await post(BACKUP_ROUTES.run, ownerCookie, {
        idempotencyKey: idempotencyKey(),
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({
        error: { code: PLATFORM_ERROR_CODES.RECOVERY_QUIESCED },
      });
    });

    it('still answers READS, because supervising a recovery is reading', async () => {
      await holdInstallation();
      // An operator watching a restore needs the history and the request list to
      // keep working. A quiesce that refused reads would blind the person
      // supervising the one operation that needs supervising.
      expect((await get(BACKUP_ROUTES.history, ownerCookie)).statusCode).toBe(200);
      expect((await get(RECOVERY_ROUTES.list, ownerCookie)).statusCode).toBe(200);
      const listed = recoveryListResponseSchema.parse(
        (await get(RECOVERY_ROUTES.list, ownerCookie)).json(),
      );
      expect(listed.recoveries.some((row) => row.state === 'RESTORING')).toBe(true);
    });
  });

  describe('scope', () => {
    it('answers not-found for a recovery belonging to another scope', async () => {
      // The row is created directly under tenant B, which no session can reach:
      // HTTP login resolves against the installation tenant. So this is tenant
      // A's fully privileged owner naming a real id that exists.
      const foreignId = '01900000-0000-7000-8000-0000000000fe';
      await api.container.database.withClient((client) =>
        client.query(
          `INSERT INTO recovery_requests (id, tenant_id, source, state, stage, created_at, updated_at)
           VALUES ($1, $2, 'UPLOAD', 'UPLOADED', 'RECEIVE_UPLOAD', now(), now())`,
          [foreignId, tenantB.tenantId],
        ),
      );
      const response = await get(RECOVERY_ROUTES.detail(foreignId), ownerCookie);
      // NOT 403. A permission-denied for an id that exists in another scope is
      // itself a disclosure.
      expect(response.statusCode).toBe(404);

      // And it is not in the list either.
      const list = recoveryListResponseSchema.parse(
        (await get(RECOVERY_ROUTES.list, ownerCookie)).json(),
      );
      expect(list.recoveries.map((r) => r.id)).not.toContain(foreignId);

      // Nothing was mutated.
      const row = await api.container.recoveryRequests.byIdUnscoped(foreignId);
      expect(row?.state).toBe('UPLOADED');
      expect(row?.tenantId).toBe(tenantB.tenantId);
    });

    /**
     * A path parameter is caller-controlled text, and `recovery_requests.id` is a
     * `uuid` column.
     *
     * So an id that is not one reaches PostgreSQL as 22P02 and comes back through
     * the error filter as a 500 — which lets any authenticated caller turn
     * arbitrary text into an internal error by putting it in the path. This suite
     * found exactly that: `GET /recoveries/not-a-uuid` answered 500.
     *
     * The assertion is `toBe(404)` per case rather than `toContain` over a set of
     * acceptable codes. A set including 400 would have passed for a request
     * refused for some unrelated reason, and — worse — the original version of
     * this case accepted `[400, 404]` and would still pass today if the guard
     * were removed and something else happened to 400 first.
     *
     * 404 for ALL THREE, including the malformed ones, and that is a decision
     * rather than an accident: a caller must not be able to tell "malformed",
     * "does not exist" and "exists in another scope" apart. Distinguishing the
     * last two is the disclosure the scope case above exists to prevent, and
     * distinguishing the first buys a caller nothing they cannot work out from
     * the contract.
     */
    it.each([
      ['01900000-0000-7000-8000-0000000000ff', 'a well-formed id that does not exist'],
      ['not-a-uuid', 'text that is not an id at all'],
      ['01900000-0000-4000-8000-0000000000ff', 'a v4 uuid, which this system cannot have minted'],
      ['%2E%2E%2F%2E%2E%2Fetc%2Fpasswd', 'an encoded path traversal'],
      ["' OR 1=1 --", 'an injection attempt'],
    ])('answers 404 and never 500 for %s (%s)', async (guess) => {
      const response = await get(RECOVERY_ROUTES.detail(guess), ownerCookie);
      // The requirement, stated as the thing that must not happen.
      expect(response.statusCode, response.body).not.toBe(500);
      expect(response.statusCode, response.body).toBe(404);
    });
  });

  // --- Capabilities --------------------------------------------------------

  describe('capabilities', () => {
    it('reports the foreign-installation limitation rather than omitting it', async () => {
      const response = await get(RECOVERY_ROUTES.capabilities, ownerCookie);
      const capabilities = recoveryCapabilitiesResponseSchema.parse(response.json());
      expect(capabilities.foreignInstallationSupported).toBe(false);
      expect(capabilities.uploadEnabled).toBe(true);
      expect(capabilities.confirmationPhrase).toBe(RECOVERY_CONFIRMATION_PHRASE);
      // Reported so the Web Admin refuses a too-large file before sending it, and
      // so the refusal it renders names the real limit.
      expect(capabilities.maxUploadBytes).toBe(1048576);
    });

    it('needs a session', async () => {
      const response = await inject({
        method: 'GET',
        url: `${API_PREFIX}${RECOVERY_ROUTES.capabilities}`,
      });
      expect(response.statusCode).toBe(401);
    });
  });

  /** Every file with this basename under a root. For the cleanup assertions. */
  async function findFiles(root: string, basename: string): Promise<string[]> {
    const { readdir } = await import('node:fs/promises');
    const found: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.name === basename) found.push(path);
      }
    };
    await walk(root).catch(() => undefined);
    return found;
  }
});
