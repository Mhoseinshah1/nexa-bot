import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  API_PREFIX,
  AUTH_ROUTES,
  importRecoveryKitResponseSchema,
  installationKeysResponseSchema,
  PLATFORM_ERROR_CODES,
  RECOVERY_KIT_ROUTES,
  SESSION_COOKIE_NAME,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import {
  FAST_KIT_KDF,
  kekFingerprint,
  openRecoveryKit,
  sealRecoveryKit,
} from '../../apps/api/src/infrastructure/crypto/recovery-kit';
import { wrapInstallationKey } from '../../apps/api/src/infrastructure/crypto/installation-keyring';
import { AesGcmSecretCipher } from '../../apps/api/src/infrastructure/crypto/secret-cipher';
import { sealArchive } from '../../apps/api/src/modules/platform/backup/infrastructure/archive';
import { InstallationKeyService } from '../../apps/api/src/modules/platform/recovery/application/installation-key.service';
import type { InstallationKeyRepository } from '../../apps/api/src/modules/platform/recovery/application/installation-key.ports';
import {
  adminActorFor,
  createAdmin,
  migrateOnce,
  resetDatabase,
  tenantA,
  TEST_KEK,
  testConfig,
} from './harness';

/**
 * The Recovery Kit's key lifecycle over HTTP (ADR-0032): export, import, list,
 * remove — and every refusal the owner's specification names that needs a
 * database: a key collision, an attempt to replace the ACTIVE key, a partial
 * import, and removal with dependencies. The format's own negatives are in
 * `tests/unit/recovery-kit.test.ts`; the restore on a fresh install is in
 * `recovery-kit-restore.test.ts`.
 */

const ORIGIN = 'https://admin.example.test';
const PASSPHRASE = 'a passphrase of decent length';
const OWNER_PASSWORD = 'the-owners-real-password';

describe('the Recovery Kit key lifecycle', () => {
  let api: ApiApp;
  let ownerCookie: string;
  let observerCookie: string;
  let workRoot: string;
  let recoveryRoot: string;
  const activeKey = Buffer.from(TEST_KEK, 'base64');

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  beforeAll(async () => {
    workRoot = await mkdtemp(join(tmpdir(), 'nexa-kit-api-backups-'));
    recoveryRoot = await mkdtemp(join(tmpdir(), 'nexa-kit-api-recovery-'));
    const config = testConfig({
      WEB_ADMIN_ORIGINS: ORIGIN,
      BACKUP_WORK_DIR: workRoot,
      RECOVERY_WORK_DIR: recoveryRoot,
    });
    await migrateOnce(config.DATABASE_URL);
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
    // The keyring is process state; the table was just truncated.
    await api.container.installationKeyLoader.refresh();
    await rm(workRoot, { recursive: true, force: true });
    await mkdir(workRoot, { recursive: true });

    await createAdmin(api.container, tenantA, {
      username: 'owner',
      password: OWNER_PASSWORD,
      roleKeys: ['owner'],
    });
    await createAdmin(api.container, tenantA, {
      username: 'observer',
      password: 'the-observers-password',
      roleKeys: ['observer'],
    });
    ownerCookie = await cookieFor('owner', OWNER_PASSWORD);
    observerCookie = await cookieFor('observer', 'the-observers-password');
  });

  async function cookieFor(username: string, password: string): Promise<string> {
    const response = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username, password },
    });
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(
      String(response.headers['set-cookie'] ?? ''),
    );
    if (match === null) throw new Error(`No session cookie for ${username}.`);
    return `${SESSION_COOKIE_NAME}=${match[1] as string}`;
  }

  const post = (path: string, cookie: string, payload: unknown) =>
    inject({
      method: 'POST',
      url: `${API_PREFIX}${path}`,
      headers: { cookie, origin: ORIGIN },
      payload: payload as never,
    });
  const get = (path: string, cookie: string) =>
    inject({ method: 'GET', url: `${API_PREFIX}${path}`, headers: { cookie, origin: ORIGIN } });

  let keyCounter = 0;
  const idempotencyKey = () => `kit-key-${(keyCounter += 1)}-${Date.now()}`;

  const kitOf = (keys: { keyId: string; material: Buffer }[], passphrase = PASSPHRASE) =>
    sealRecoveryKit({
      keys,
      passphrase,
      profile: FAST_KIT_KDF,
      kitId: randomUUID(),
      createdAt: new Date(),
    });

  const importKit = async (kit: Buffer, passphrase = PASSPHRASE, key = idempotencyKey()) =>
    post(RECOVERY_KIT_ROUTES.import, ownerCookie, {
      kit: kit.toString('base64'),
      passphrase,
      accountPassword: OWNER_PASSWORD,
      idempotencyKey: key,
    });

  async function keys() {
    const response = await get(RECOVERY_KIT_ROUTES.keys, ownerCookie);
    expect(response.statusCode, response.body).toBe(200);
    return installationKeysResponseSchema.parse(response.json()).keys;
  }

  async function auditText(): Promise<string> {
    const rows = await api.container.database.db.execute(
      sql`SELECT action, result, before, after FROM audit_logs ORDER BY occurred_at`,
    );
    return JSON.stringify(rows.rows);
  }

  // --- Export ---------------------------------------------------------------

  describe('export', () => {
    const exportBody = (overrides: Record<string, unknown> = {}) => ({
      accountPassword: OWNER_PASSWORD,
      passphrase: PASSPHRASE,
      passphraseConfirmation: PASSPHRASE,
      ...overrides,
    });

    it('exports every held key as a kit the passphrase opens', async () => {
      const response = await post(RECOVERY_KIT_ROUTES.export, ownerCookie, exportBody());
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['content-type']).toContain('application/octet-stream');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(String(response.headers['content-disposition'])).toMatch(
        /^attachment; filename="nexa-recovery-kit-\d{8}\.nxkit"$/,
      );
      const opened = await openRecoveryKit(response.rawPayload, PASSPHRASE);
      expect(opened.keys.map((k) => k.keyId)).toEqual(['test-1']);
      expect(opened.keys[0]?.material.equals(activeKey)).toBe(true);

      // Audited by id and fingerprint, never by bytes or passphrase.
      const audit = await auditText();
      expect(audit).toContain('recovery_kit.exported');
      expect(audit).toContain(kekFingerprint(activeKey));
      expect(audit).not.toContain(TEST_KEK);
      expect(audit).not.toContain(activeKey.toString('base64url'));
      expect(audit).not.toContain(PASSPHRASE);
      expect(audit).not.toContain(OWNER_PASSWORD);
    });

    it('needs the account password as well as the session', async () => {
      const response = await post(
        RECOVERY_KIT_ROUTES.export,
        ownerCookie,
        exportBody({ accountPassword: 'not-my-password' }),
      );
      // 400, not 401: the session is fine and must stay signed in.
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe(
        PLATFORM_ERROR_CODES.RECOVERY_KIT_REAUTHENTICATION_FAILED,
      );
      expect(response.body).not.toContain('not-my-password');
      expect(await auditText()).toContain('REAUTHENTICATION_FAILED');
    });

    it('refuses a passphrase that is short, or typed differently twice', async () => {
      for (const body of [
        exportBody({ passphrase: 'short', passphraseConfirmation: 'short' }),
        exportBody({ passphraseConfirmation: `${PASSPHRASE}!` }),
      ]) {
        const response = await post(RECOVERY_KIT_ROUTES.export, ownerCookie, body);
        expect(response.statusCode).toBe(400);
        expect(response.json().error.code).toBe(
          PLATFORM_ERROR_CODES.RECOVERY_KIT_PASSPHRASE_REJECTED,
        );
        expect(response.body).not.toContain(PASSPHRASE);
      }
    });

    it('is refused without the permission, and the refusal is audited', async () => {
      const response = await post(RECOVERY_KIT_ROUTES.export, observerCookie, exportBody());
      expect(response.statusCode).toBe(403);
      expect(await auditText()).toContain('recovery_kit.export');
    });
  });

  // --- Import ---------------------------------------------------------------

  describe('import', () => {
    it('imports a new key decrypt-only, and the active key stays the configured one', async () => {
      const old = randomBytes(32);
      const response = await importKit(
        await kitOf([
          { keyId: 'test-1', material: activeKey },
          { keyId: 'old-1', material: old },
        ]),
      );
      expect(response.statusCode, response.body).toBe(201);
      const body = importRecoveryKitResponseSchema.parse(response.json());
      expect(body.imported.map((k) => k.keyId)).toEqual(['old-1']);
      expect(body.alreadyHeld.map((k) => k.keyId)).toEqual(['test-1']);

      expect(api.container.keyring.activeKeyId).toBe('test-1');
      expect(api.container.keyring.keys.get('old-1')?.equals(old)).toBe(true);
      const listed = await keys();
      expect(listed.find((k) => k.keyId === 'old-1')).toMatchObject({
        origin: 'IMPORTED',
        encrypts: false,
        available: true,
        removable: true,
      });
      expect(listed.find((k) => k.keyId === 'test-1')).toMatchObject({
        origin: 'CONFIGURED_ACTIVE',
        encrypts: true,
        removable: false,
      });
      // A new secret is still sealed under the configured key.
      expect(
        api.container.cipher.encrypt('x', {
          purpose: 'bot_instance.token',
          tenantId: tenantA.tenantId,
          entityId: randomUUID(),
        }).keyId,
      ).toBe('test-1');

      // Stored wrapped, never in the clear.
      const stored = JSON.stringify(
        (await api.container.database.db.execute(sql`SELECT * FROM installation_keys`)).rows,
      );
      expect(stored).not.toContain(old.toString('base64url'));
      expect(stored).not.toContain(old.toString('base64'));
      expect(await auditText()).not.toContain(old.toString('base64url'));
    });

    it('REFUSES an attempt to replace the active key, and writes nothing', async () => {
      // A kit claiming the active key's id with different bytes: honoured, this
      // would silently swap the key every new secret is sealed with.
      const response = await importKit(
        await kitOf([
          { keyId: 'harmless-1', material: randomBytes(32) },
          { keyId: 'test-1', material: randomBytes(32) },
        ]),
      );
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe(PLATFORM_ERROR_CODES.RECOVERY_KIT_KEY_COLLISION);
      expect(await api.container.installationKeyRepository.all()).toHaveLength(0);
      expect(api.container.keyring.keys.get('test-1')?.equals(activeKey)).toBe(true);
      expect(api.container.keyring.keys.has('harmless-1')).toBe(false);
    });

    it('refuses a COLLISION with an already-imported key, whole', async () => {
      expect(
        (await importKit(await kitOf([{ keyId: 'old-1', material: randomBytes(32) }]))).statusCode,
      ).toBe(201);
      const response = await importKit(
        await kitOf([
          { keyId: 'old-2', material: randomBytes(32) },
          { keyId: 'old-1', material: randomBytes(32) },
        ]),
      );
      expect(response.statusCode).toBe(409);
      expect((await api.container.installationKeyRepository.all()).map((r) => r.keyId)).toEqual([
        'old-1',
      ]);
    });

    it('refuses a wrong passphrase and a corrupted kit, and writes nothing', async () => {
      const kit = await kitOf([{ keyId: 'old-1', material: randomBytes(32) }]);
      const wrong = await importKit(kit, 'the wrong passphrase entirely');
      expect(wrong.statusCode).toBe(400);
      expect(wrong.json().error.code).toBe(PLATFORM_ERROR_CODES.RECOVERY_KIT_AUTH_FAILED);
      expect(wrong.body).not.toContain('the wrong passphrase');

      const corrupted = Buffer.from(kit);
      corrupted[corrupted.length - 20] = (corrupted[corrupted.length - 20] ?? 0) ^ 0xff;
      const damaged = await importKit(corrupted);
      expect(damaged.json().error.code).toBe(PLATFORM_ERROR_CODES.RECOVERY_KIT_AUTH_FAILED);
      expect(await api.container.installationKeyRepository.all()).toHaveLength(0);
      expect(await auditText()).toContain('recovery_kit.auth_failed');
    });

    it('replays an idempotency key, and refuses it reused for a different kit', async () => {
      const key = idempotencyKey();
      const kit = await kitOf([{ keyId: 'old-1', material: randomBytes(32) }]);
      const first = await importKit(kit, PASSPHRASE, key);
      const second = await importKit(kit, PASSPHRASE, key);
      expect(second.statusCode).toBe(201);
      expect(second.json()).toEqual(first.json());
      const other = await importKit(
        await kitOf([{ keyId: 'old-2', material: randomBytes(32) }]),
        PASSPHRASE,
        key,
      );
      expect(other.statusCode).toBe(409);
    });

    it('rolls back a PARTIAL import: a failure on one key leaves none written', async () => {
      // The real service over a repository whose SECOND insert fails — the shape
      // of a crash, a constraint, a lost connection half-way through a kit.
      const real = api.container.installationKeyRepository;
      let inserts = 0;
      const failing: InstallationKeyRepository = {
        all: (tx) => real.all(tx),
        lock: (tx) => real.lock(tx),
        upsertImported: async (tx, row) => {
          inserts += 1;
          if (inserts === 2) throw new Error('the disk went away');
          return real.upsertImported(tx, row);
        },
        tombstone: (tx, keyId, fp, at, by) => real.tombstone(tx, keyId, fp, at, by),
        rewrap: (tx, keyId, expected, next) => real.rewrap(tx, keyId, expected, next),
        secretCountsByKeyId: () => real.secretCountsByKeyId(),
        openRecoveryWorkspaces: () => real.openRecoveryWorkspaces(),
      };
      const service = new InstallationKeyService({
        ...(api.container.installationKeys as unknown as { deps: object }).deps,
        keys: failing,
      } as never);
      const owner = (
        await api.container.database.db.execute(
          sql`SELECT id, username FROM admins WHERE username = 'owner'`,
        )
      ).rows[0] as { id: string; username: string };

      await expect(
        service.importKit(tenantA, adminActorFor(owner as never), {
          kit: (
            await kitOf([
              { keyId: 'old-1', material: randomBytes(32) },
              { keyId: 'old-2', material: randomBytes(32) },
              { keyId: 'old-3', material: randomBytes(32) },
            ])
          ).toString('base64'),
          passphrase: PASSPHRASE,
          accountPassword: OWNER_PASSWORD,
          idempotencyKey: idempotencyKey(),
        }),
      ).rejects.toThrow('the disk went away');
      expect(inserts).toBe(2);
      expect(await real.all()).toHaveLength(0);
      expect(api.container.keyring.importedKeys.size).toBe(0);
    });

    // --- PR #144 review fixes ------------------------------------------------

    it('needs the account password as well as the session (step-up), and writes nothing without it', async () => {
      const kit = await kitOf([{ keyId: 'attacker-1', material: randomBytes(32) }]);
      const wrong = await post(RECOVERY_KIT_ROUTES.import, ownerCookie, {
        kit: kit.toString('base64'),
        passphrase: PASSPHRASE,
        accountPassword: 'a-stolen-session-does-not-know-this',
        idempotencyKey: idempotencyKey(),
      });
      // 400, not 401: the session stays signed in.
      expect(wrong.statusCode).toBe(400);
      expect(wrong.json().error.code).toBe(
        PLATFORM_ERROR_CODES.RECOVERY_KIT_REAUTHENTICATION_FAILED,
      );
      const missing = await post(RECOVERY_KIT_ROUTES.import, ownerCookie, {
        kit: kit.toString('base64'),
        passphrase: PASSPHRASE,
        idempotencyKey: idempotencyKey(),
      });
      expect(missing.statusCode).toBe(400);
      expect(await api.container.installationKeyRepository.all()).toHaveLength(0);
      expect(api.container.keyring.keys.has('attacker-1')).toBe(false);
      expect(await auditText()).toContain('REAUTHENTICATION_FAILED');
    });

    it('imports bytes already held under ANOTHER name as that name, so the name resolves', async () => {
      // The kit calls the active key `alias-1`. Reporting it "already held" left
      // `alias-1` unresolvable, and an archive naming it foreign.
      const response = await importKit(await kitOf([{ keyId: 'alias-1', material: activeKey }]));
      expect(response.statusCode, response.body).toBe(201);
      expect(
        importRecoveryKitResponseSchema.parse(response.json()).imported.map((k) => k.keyId),
      ).toEqual(['alias-1']);
      expect(api.container.keyring.keys.get('alias-1')?.equals(activeKey)).toBe(true);
      // Still decrypt-only: the configured key encrypts.
      expect(api.container.keyring.activeKeyId).toBe('test-1');
    });

    it('does not replay an earlier success for a wrong passphrase', async () => {
      const key = idempotencyKey();
      const kit = await kitOf([{ keyId: 'old-1', material: randomBytes(32) }]);
      expect((await importKit(kit, PASSPHRASE, key)).statusCode).toBe(201);
      const replayed = await importKit(kit, 'not the passphrase at all', key);
      expect(replayed.statusCode).toBe(400);
      expect(replayed.json().error.code).toBe(PLATFORM_ERROR_CODES.RECOVERY_KIT_AUTH_FAILED);
    });

    it('refuses an import that would leave more keys than one kit can carry', async () => {
      // 64 new keys plus the configured one is 65; the next export would fail.
      const keys = Array.from({ length: 64 }, (_, index) => ({
        keyId: `bulk-${String(index)}`,
        material: randomBytes(32),
      }));
      const response = await importKit(await kitOf(keys));
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe(PLATFORM_ERROR_CODES.RECOVERY_KIT_TOO_MANY_KEYS);
      expect(await api.container.installationKeyRepository.all()).toHaveLength(0);
      expect(await auditText()).toContain('TOO_MANY_KEYS');
    });

    it('revives a removed key only by importing it again, explicitly', async () => {
      const material = randomBytes(32);
      expect((await importKit(await kitOf([{ keyId: 'old-1', material }]))).statusCode).toBe(201);
      const removed = await post(RECOVERY_KIT_ROUTES.remove, ownerCookie, {
        keyId: 'old-1',
        confirmation: 'old-1',
        idempotencyKey: idempotencyKey(),
      });
      expect(removed.statusCode, removed.body).toBe(201);
      expect(api.container.keyring.keys.has('old-1')).toBe(false);
      expect((await importKit(await kitOf([{ keyId: 'old-1', material }]))).statusCode).toBe(201);
      const [row] = await api.container.installationKeyRepository.all();
      expect(row?.removedAt).toBeNull();
      expect(api.container.keyring.keys.get('old-1')?.equals(material)).toBe(true);
    });

    it('is refused without the permission', async () => {
      const response = await post(RECOVERY_KIT_ROUTES.import, observerCookie, {
        kit: (await kitOf([{ keyId: 'old-1', material: randomBytes(32) }])).toString('base64'),
        passphrase: PASSPHRASE,
        accountPassword: 'the-observers-password',
        idempotencyKey: idempotencyKey(),
      });
      expect(response.statusCode).toBe(403);
      expect(await api.container.installationKeyRepository.all()).toHaveLength(0);
    });
  });

  // --- Removal --------------------------------------------------------------

  describe('removal', () => {
    const remove = (keyId: string, confirmation = keyId) =>
      post(RECOVERY_KIT_ROUTES.remove, ownerCookie, {
        keyId,
        confirmation,
        idempotencyKey: idempotencyKey(),
      });

    async function importOld(): Promise<Buffer> {
      const old = randomBytes(32);
      const response = await importKit(await kitOf([{ keyId: 'old-1', material: old }]));
      expect(response.statusCode, response.body).toBe(201);
      return old;
    }

    it('removes an imported key nothing depends on, and audits it', async () => {
      await importOld();
      const response = await remove('old-1');
      expect(response.statusCode, response.body).toBe(201);
      // A TOMBSTONE: the bytes erased, the row kept so a restore cannot revive it.
      const [tombstone] = await api.container.installationKeyRepository.all();
      expect(tombstone?.wrappedMaterial).toBeNull();
      expect(tombstone?.wrappedUnderKeyId).toBeNull();
      expect(tombstone?.removedAt).not.toBeNull();
      expect(api.container.keyring.keys.has('old-1')).toBe(false);
      expect(await auditText()).toContain('installation_key.removed');
    });

    it('never removes a configured key, and needs the label typed exactly', async () => {
      await importOld();
      const configured = await remove('test-1');
      expect(configured.statusCode).toBe(400);
      expect(configured.json().error.code).toBe(
        PLATFORM_ERROR_CODES.INSTALLATION_KEY_NOT_REMOVABLE,
      );
      const mistyped = await remove('old-1', 'old-2');
      expect(mistyped.statusCode).toBe(400);
      expect(await api.container.installationKeyRepository.all()).toHaveLength(1);
    });

    it('refuses while a stored SECRET still needs the key', async () => {
      const old = await importOld();
      // A bot token sealed under the imported key — what a restore leaves behind.
      const [bot] = (
        await api.container.database.db.execute(
          sql`SELECT id, tenant_id FROM bot_instances ORDER BY id LIMIT 1`,
        )
      ).rows as { id: string; tenant_id: string }[];
      const sealed = new AesGcmSecretCipher(
        { activeKeyId: 'old-1', keys: new Map([['old-1', old]]), format: 'canonical' },
        false,
      ).encrypt('a restored token', {
        purpose: 'bot_instance.token',
        tenantId: bot!.tenant_id,
        entityId: bot!.id,
      });
      await api.container.database.db.execute(
        sql`UPDATE bot_instances SET token_ciphertext = ${sealed.ciphertext}, token_key_id = 'old-1' WHERE id = ${bot!.id}`,
      );

      const response = await remove('old-1');
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe(PLATFORM_ERROR_CODES.INSTALLATION_KEY_IN_USE);
      expect(response.json().error.details.dependencies.secrets).toBe(1);
      expect((await keys()).find((k) => k.keyId === 'old-1')?.removable).toBe(false);
      expect(await api.container.installationKeyRepository.all()).toHaveLength(1);
      expect(await auditText()).toContain('IN_USE');
    });

    it('refuses while a RETAINED ARCHIVE on disk is sealed under the key', async () => {
      const old = await importOld();
      const backupId = randomUUID();
      const directory = join(workRoot, backupId);
      await mkdir(directory, { recursive: true });
      const payload = Buffer.from('PGDMP not really a dump');
      await writeFile(join(directory, 'dump'), payload);
      await sealArchive({
        dumpPath: join(directory, 'dump'),
        archivePath: join(directory, 'archive.nxb'),
        keyring: { activeKeyId: 'old-1', keys: new Map([['old-1', old]]), format: 'canonical' },
        manifest: {
          manifestVersion: 1,
          backupId,
          installationId: 'old',
          createdAt: new Date().toISOString(),
          databaseName: 'nexa',
          postgresVersion: '16',
          pgDumpVersion: 'pg_dump 16',
          dumpFormat: 'custom',
          dumpBytes: payload.length,
          checksumAlgorithm: 'sha256',
          checksum: createHash('sha256').update(payload).digest('hex'),
          exclusions: [],
        } as never,
      });

      const response = await remove('old-1');
      expect(response.statusCode).toBe(409);
      expect(response.json().error.details.dependencies.retainedArchives).toBe(1);
      // No path to the archive in the answer.
      expect(response.body).not.toContain(workRoot);
    });

    it('refuses while another imported key is stored WRAPPED under it', async () => {
      const old = await importOld();
      const older = randomBytes(32);
      await api.container.installationKeyRepository.upsertImported(undefined, {
        id: randomUUID(),
        keyId: 'old-0',
        fingerprint: kekFingerprint(older),
        wrappedMaterial: wrapInstallationKey({
          keyId: 'old-0',
          material: older,
          wrappingKeyId: 'old-1',
          wrappingKey: old,
        }),
        wrappedUnderKeyId: 'old-1',
        source: 'RECOVERY_KIT',
        kitId: null,
        importedAt: new Date(),
        importedByAdminId: null,
        importedByLabel: 'a restored installation',
        removedAt: null,
        removedByLabel: null,
        restoredAt: null,
      });
      // The second generation resolves through the first.
      await api.container.installationKeyLoader.refresh();
      expect(api.container.keyring.keys.get('old-0')?.equals(older)).toBe(true);

      const response = await remove('old-1');
      expect(response.statusCode).toBe(409);
      expect(response.json().error.details.dependencies.wrappedKeys).toBe(1);
    });

    it('refuses while a backup taken AFTER the import is on disk, whatever key sealed it', async () => {
      // The archive is sealed under the ACTIVE key, so its header names test-1.
      // It was taken while old-1 was held, so the secrets inside it may be sealed
      // under old-1 — which the header cannot show.
      await importOld();
      const backupId = '01ffffff-ffff-7fff-bfff-ffffffffffff';
      const directory = join(workRoot, backupId);
      await mkdir(directory, { recursive: true });
      const payload = Buffer.from('PGDMP not really a dump');
      await writeFile(join(directory, 'dump'), payload);
      await sealArchive({
        dumpPath: join(directory, 'dump'),
        archivePath: join(directory, 'archive.nxb'),
        keyring: {
          activeKeyId: 'test-1',
          keys: new Map([['test-1', activeKey]]),
          format: 'canonical',
        },
        manifest: {
          manifestVersion: 1,
          backupId,
          installationId: 'this',
          createdAt: new Date().toISOString(),
          databaseName: 'nexa',
          postgresVersion: '16',
          pgDumpVersion: 'pg_dump 16',
          dumpFormat: 'custom',
          dumpBytes: payload.length,
          checksumAlgorithm: 'sha256',
          checksum: createHash('sha256').update(payload).digest('hex'),
          exclusions: [],
        } as never,
      });
      const response = await remove('old-1');
      expect(response.statusCode).toBe(409);
      expect(response.json().error.details.dependencies.retainedArchives).toBe(1);
    });

    it('FAILS CLOSED on an archive it cannot read: counted against every key', async () => {
      await importOld();
      const directory = join(workRoot, randomUUID());
      await mkdir(directory, { recursive: true });
      // Present and unreadable as an archive: a truncated upload, a damaged file.
      await writeFile(join(directory, 'archive.nxb'), Buffer.from('NEXABAK1'));
      const response = await remove('old-1');
      expect(response.statusCode).toBe(409);
      expect(response.json().error.details.dependencies.retainedArchives).toBe(1);
      // While a directory with NO archive in it is confirmed absent, not a dependency.
      await rm(directory, { recursive: true, force: true });
      await mkdir(join(workRoot, randomUUID()), { recursive: true });
      expect((await remove('old-1')).statusCode).toBe(201);
    });

    it('is refused without the permission', async () => {
      await importOld();
      const response = await post(RECOVERY_KIT_ROUTES.remove, observerCookie, {
        keyId: 'old-1',
        confirmation: 'old-1',
        idempotencyKey: idempotencyKey(),
      });
      expect(response.statusCode).toBe(403);
      expect(await api.container.installationKeyRepository.all()).toHaveLength(1);
    });
  });

  it("shows a configured key's fingerprint only to someone who may export the kit", async () => {
    const asObserver = installationKeysResponseSchema.parse(
      (await get(RECOVERY_KIT_ROUTES.keys, observerCookie)).json(),
    ).keys;
    expect(asObserver.find((k) => k.keyId === 'test-1')?.fingerprint).toBeNull();
    const asOwner = await keys();
    expect(asOwner.find((k) => k.keyId === 'test-1')?.fingerprint).toBe(kekFingerprint(activeKey));
  });

  it('audits an export refused for its passphrase', async () => {
    const response = await post(RECOVERY_KIT_ROUTES.export, ownerCookie, {
      accountPassword: OWNER_PASSWORD,
      passphrase: PASSPHRASE,
      passphraseConfirmation: `${PASSPHRASE}!`,
    });
    expect(response.statusCode).toBe(400);
    const audit = await auditText();
    expect(audit).toContain('PASSPHRASE_MISMATCH');
    expect(audit).not.toContain(PASSPHRASE);
  });

  it('lists keys to backup.view, without key bytes', async () => {
    const response = await get(RECOVERY_KIT_ROUTES.keys, observerCookie);
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(TEST_KEK);
    expect(response.body).not.toContain(activeKey.toString('base64url'));
  });
});
