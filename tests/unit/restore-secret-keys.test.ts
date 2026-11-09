import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLATFORM_ERROR_CODES, type BackupManifest } from '@nexa/contracts';
import { AesGcmSecretCipher } from '../../apps/api/src/infrastructure/crypto/secret-cipher';
import {
  heldKeysFor,
  withExtraKeys,
  type SecretKeyring,
} from '../../apps/api/src/infrastructure/crypto/keyring';
import { InstallationKeyring } from '../../apps/api/src/infrastructure/crypto/installation-keyring';
import { FAST_KDF, kekFingerprint } from '../../apps/api/src/infrastructure/crypto/kek';
import { openKeyBundle, sealKeyBundle } from '../../apps/api/src/infrastructure/crypto/key-bundle';
import {
  checksumFile,
  openArchive,
  sealArchive,
} from '../../apps/api/src/modules/platform/backup/infrastructure/archive';
import { KeyringRecoveryKeyCoverage } from '../../apps/api/src/modules/platform/recovery/infrastructure/installation-key-adapters';

/**
 * NEXA-FIX-RESTORE-SECRETS, the parts that need no database.
 *
 * The incident: install A and install B both named their key `install-20261107`,
 * with different bytes. Everything below is about one rule — an id is a LABEL,
 * and only authenticated decryption says which held key a value was sealed under.
 */

const ID = 'install-20261107';
const context = { purpose: 'bot_instance.token' as const, tenantId: 't-1', entityId: 'e-1' };

function plain(keys: Record<string, Buffer>, active: string): SecretKeyring {
  return { activeKeyId: active, keys: new Map(Object.entries(keys)), format: 'canonical' };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

function syncCodeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe('one key id, several held keys', () => {
  it("decrypts install A's secret on install B when B also holds A's key under the same id", () => {
    const a = randomBytes(32);
    const b = randomBytes(32);
    const written = new AesGcmSecretCipher(plain({ [ID]: a }, ID), false).encrypt(
      'the old bot token',
      context,
    );

    const keyring = new InstallationKeyring(plain({ [ID]: b }, ID));
    const cipher = new AesGcmSecretCipher(keyring, false);
    // B alone: the id is HELD, and the value still does not read — the incident.
    expect(syncCodeOf(() => cipher.decrypt(written, context))).toBe(
      PLATFORM_ERROR_CODES.SECRET_AUTH_FAILED,
    );
    keyring.replaceImported(new Map([[ID, a]]));
    expect(cipher.decrypt(written, context)).toBe('the old bot token');
    // New material is still sealed under B's configured bytes.
    const fresh = cipher.encrypt('new', context);
    expect(new AesGcmSecretCipher(plain({ [ID]: b }, ID), false).decrypt(fresh, context)).toBe(
      'new',
    );
  });

  it('tries the configured (active) key first, then the imported one', () => {
    const active = randomBytes(32);
    const imported = randomBytes(32);
    const keyring = new InstallationKeyring(plain({ [ID]: active }, ID));
    keyring.replaceImported(new Map([[ID, imported]]));
    const order = heldKeysFor(keyring, ID);
    expect(order).toHaveLength(2);
    expect(order[0]?.equals(active)).toBe(true);
    expect(order[1]?.equals(imported)).toBe(true);
    // And the name still resolves to the configured key.
    expect(keyring.keys.get(ID)?.equals(active)).toBe(true);
  });

  it('never yields plaintext from a failed authentication, whichever candidates are held', () => {
    const a = randomBytes(32);
    const b = randomBytes(32);
    const c = randomBytes(32);
    const keyring = new InstallationKeyring(plain({ [ID]: b }, ID));
    keyring.replaceImported(new Map([[ID, a]]));
    const cipher = new AesGcmSecretCipher(keyring, false);

    // Sealed under a THIRD key that shares the id: no candidate authenticates.
    const foreign = new AesGcmSecretCipher(plain({ [ID]: c }, ID), false).encrypt('x', context);
    expect(syncCodeOf(() => cipher.decrypt(foreign, context))).toBe(
      PLATFORM_ERROR_CODES.SECRET_AUTH_FAILED,
    );

    // Sealed under a held key, then one payload bit flipped: refused, not garbled.
    const sealed = new AesGcmSecretCipher(plain({ [ID]: a }, ID), false).encrypt(
      'payload',
      context,
    );
    const parts = sealed.ciphertext.split('.');
    const body = Buffer.from(parts[6] ?? '', 'base64url');
    body[0] = (body[0] ?? 0) ^ 0x01;
    parts[6] = body.toString('base64url');
    expect(
      syncCodeOf(() => cipher.decrypt({ ...sealed, ciphertext: parts.join('.') }, context)),
    ).toBe(PLATFORM_ERROR_CODES.SECRET_AUTH_FAILED);

    // And the right value under the WRONG context (another row) is refused too.
    expect(syncCodeOf(() => cipher.decrypt(sealed, { ...context, entityId: 'another-row' }))).toBe(
      PLATFORM_ERROR_CODES.SECRET_AUTH_FAILED,
    );
  });

  it('a recovery-only extra key is tried after every held key and never becomes active', () => {
    const active = randomBytes(32);
    const extra = randomBytes(32);
    const base = new InstallationKeyring(plain({ [ID]: active }, ID));
    const ring = withExtraKeys(base, [{ keyId: ID, material: extra }]);
    expect(ring.activeKeyId).toBe(ID);
    expect(ring.keys.get(ID)?.equals(active)).toBe(true);
    const order = heldKeysFor(ring, ID);
    expect(order.map((k) => k.equals(active))).toEqual([true, false]);
    const written = new AesGcmSecretCipher(plain({ [ID]: extra }, ID), false).encrypt('v', context);
    const cipher = new AesGcmSecretCipher(ring, false);
    expect(cipher.decrypt(written, context)).toBe('v');
    // The base keyring did not learn the extra key.
    expect(syncCodeOf(() => new AesGcmSecretCipher(base, false).decrypt(written, context))).toBe(
      PLATFORM_ERROR_CODES.SECRET_AUTH_FAILED,
    );
  });

  describe('the keyring archive under a shared id', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'nexa-shared-id-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("opens install A's .nxb on install B once A's key is held beside B's under the same id", async () => {
      const a = randomBytes(32);
      const b = randomBytes(32);
      const dumpPath = join(dir, 'dump');
      await writeFile(dumpPath, Buffer.concat([Buffer.from('PGDMP'), randomBytes(1000)]));
      const manifest: BackupManifest = {
        manifestVersion: 1,
        backupId: randomUUID(),
        installationId: 'a',
        createdAt: new Date().toISOString(),
        databaseName: 'nexa',
        postgresVersion: '16',
        pgDumpVersion: 'pg_dump 16',
        dumpFormat: 'custom',
        dumpBytes: 1005,
        checksumAlgorithm: 'sha256',
        checksum: (await checksumFile(dumpPath)).checksum,
        exclusions: [],
      };
      const archivePath = join(dir, 'archive.nxb');
      await sealArchive({ dumpPath, archivePath, manifest, keyring: plain({ [ID]: a }, ID) });

      const keyring = new InstallationKeyring(plain({ [ID]: b }, ID));
      expect(await codeOf(openArchive({ archivePath, dumpPath: join(dir, 'x'), keyring }))).toBe(
        PLATFORM_ERROR_CODES.BACKUP_ARCHIVE_AUTH_FAILED,
      );
      keyring.replaceImported(new Map([[ID, a]]));
      const opened = await openArchive({ archivePath, dumpPath: join(dir, 'y'), keyring });
      expect(opened.dumpChecksum).toBe(manifest.checksum);
    });
  });
});

describe('the key bundle a self-contained backup carries', () => {
  const backupId = '0192f000-0000-7000-8000-00000000bbbb';
  const password = 'the owner’s backup password';

  it('round-trips two different keys under one id, with only the password', async () => {
    const a = randomBytes(32);
    const b = randomBytes(32);
    const bundle = await sealKeyBundle({
      keys: [
        { keyId: ID, material: a },
        { keyId: ID, material: b },
      ],
      password,
      backupId,
      profile: FAST_KDF,
    });
    const opened = await openKeyBundle({ bundle, password, backupId });
    expect(opened.map((k) => k.keyId)).toEqual([ID, ID]);
    expect(opened[0]?.material.equals(a)).toBe(true);
    expect(opened[1]?.material.equals(b)).toBe(true);
    expect(opened[0]?.fingerprint).toBe(kekFingerprint(a));
  });

  it('holds no key material in any encoding — only ids, fingerprints and ciphertext', async () => {
    const material = randomBytes(32);
    const bundle = await sealKeyBundle({
      keys: [{ keyId: ID, material }],
      password,
      backupId,
      profile: FAST_KDF,
    });
    const text = bundle.toString('utf8');
    for (const encoding of ['base64', 'base64url', 'hex'] as const) {
      expect(text).not.toContain(material.toString(encoding));
    }
    expect(bundle.includes(material)).toBe(false);
    expect(text).not.toContain(password);
  });

  it('a wrong password opens nothing and says only that it did not authenticate', async () => {
    const bundle = await sealKeyBundle({
      keys: [{ keyId: ID, material: randomBytes(32) }],
      password,
      backupId,
      profile: FAST_KDF,
    });
    let caught: unknown;
    let opened: unknown;
    try {
      opened = await openKeyBundle({ bundle, password: 'not the password', backupId });
    } catch (error) {
      caught = error;
    }
    expect(opened).toBeUndefined();
    expect((caught as { code?: string }).code).toBe(
      PLATFORM_ERROR_CODES.BACKUP_ARCHIVE_AUTH_FAILED,
    );
    expect(JSON.stringify(caught)).not.toContain('not the password');
    expect((caught as { details?: unknown }).details ?? {}).toEqual({});
  });

  it('a wrapped key moved to another backup, relabelled, or re-fingerprinted fails', async () => {
    const material = randomBytes(32);
    const bundle = await sealKeyBundle({
      keys: [{ keyId: ID, material }],
      password,
      backupId,
      profile: FAST_KDF,
    });
    const doc = JSON.parse(bundle.toString('utf8')) as {
      backupId: string;
      keys: { keyId: string; fingerprint: string }[];
    };

    // Another backup's id, consistently rewritten: the AAD no longer matches.
    const moved = { ...doc, backupId: '0192f000-0000-7000-8000-00000000cccc' };
    expect(
      await codeOf(
        openKeyBundle({
          bundle: Buffer.from(JSON.stringify(moved)),
          password,
          backupId: moved.backupId,
        }),
      ),
    ).toBe(PLATFORM_ERROR_CODES.BACKUP_ARCHIVE_AUTH_FAILED);

    const relabelled = { ...doc, keys: doc.keys.map((k) => ({ ...k, keyId: 'other-id' })) };
    expect(
      await codeOf(
        openKeyBundle({ bundle: Buffer.from(JSON.stringify(relabelled)), password, backupId }),
      ),
    ).toBe(PLATFORM_ERROR_CODES.BACKUP_ARCHIVE_AUTH_FAILED);

    const other = kekFingerprint(randomBytes(32));
    const refingered = { ...doc, keys: doc.keys.map((k) => ({ ...k, fingerprint: other })) };
    expect(
      await codeOf(
        openKeyBundle({ bundle: Buffer.from(JSON.stringify(refingered)), password, backupId }),
      ),
    ).toBe(PLATFORM_ERROR_CODES.BACKUP_ARCHIVE_AUTH_FAILED);

    // And a bundle opened for a different backup than the one it names.
    expect(await codeOf(openKeyBundle({ bundle, password, backupId: moved.backupId }))).toBe(
      PLATFORM_ERROR_CODES.BACKUP_ARCHIVE_MALFORMED,
    );
  });

  it('refuses a bundle naming a KDF profile this release does not write, before deriving anything', async () => {
    const bundle = await sealKeyBundle({
      keys: [{ keyId: ID, material: randomBytes(32) }],
      password,
      backupId,
      profile: FAST_KDF,
    });
    const doc = JSON.parse(bundle.toString('utf8')) as { kdf: Record<string, unknown> };
    // 256 MiB of scrypt, well inside the schema's bounds and not an accepted profile.
    // Derived, it would fail the tag (AUTH_FAILED) after seconds of work; refused
    // first, it is MALFORMED at once.
    const oversized = { ...doc, kdf: { ...doc.kdf, log2N: 18, r: 8, p: 4 } };
    const started = Date.now();
    expect(
      await codeOf(
        openKeyBundle({ bundle: Buffer.from(JSON.stringify(oversized)), password, backupId }),
      ),
    ).toBe(PLATFORM_ERROR_CODES.BACKUP_ARCHIVE_MALFORMED);
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe('bundled keys waiting for the executor', () => {
  function coverage(keyring: InstallationKeyring): KeyringRecoveryKeyCoverage {
    return new KeyringRecoveryKeyCoverage(keyring, {} as never, {} as never, {} as never);
  }

  it('round-trip under the configured active key, for that recovery only', () => {
    const active = randomBytes(32);
    const carried = randomBytes(32);
    const keys = coverage(new InstallationKeyring(plain({ kb: active }, 'kb')));
    const sealed = keys.sealForExecutor('recovery-1', [{ keyId: ID, material: carried }]);
    for (const encoding of ['base64', 'base64url', 'hex'] as const) {
      expect(sealed).not.toContain(carried.toString(encoding));
    }
    const opened = keys.openForExecutor('recovery-1', sealed);
    expect(opened[0]?.material.equals(carried)).toBe(true);
    // Another recovery's file does not open as this one's.
    expect(() => keys.openForExecutor('recovery-2', sealed)).toThrow();
    // Nor on an installation that does not hold the wrapping key's bytes.
    const elsewhere = coverage(new InstallationKeyring(plain({ kb: randomBytes(32) }, 'kb')));
    expect(() => elsewhere.openForExecutor('recovery-1', sealed)).toThrow();
  });
});
