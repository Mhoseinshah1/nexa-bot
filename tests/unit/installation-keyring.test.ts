import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PLATFORM_ERROR_CODES } from '@nexa/contracts';
import { kekFingerprint } from '../../apps/api/src/infrastructure/crypto/kek';
import {
  InstallationKeyring,
  resolveStoredKeys,
  unwrapInstallationKey,
  wrapInstallationKey,
} from '../../apps/api/src/infrastructure/crypto/installation-keyring';
import { AesGcmSecretCipher } from '../../apps/api/src/infrastructure/crypto/secret-cipher';
import type { SecretKeyring } from '../../apps/api/src/infrastructure/crypto/keyring';

/**
 * The decrypt-only keys an installation still holds from a Recovery Kit imported before the
 * kit was removed (SFR A1), and the one property everything else rests on: an imported key
 * never encrypts.
 */

const key = (): Buffer => randomBytes(32);

function syncCodeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code ?? 'no-code';
  }
  return 'did-not-throw';
}

describe('an imported key is decrypt-only', () => {
  const configured = (keys: Record<string, Buffer>, active: string): SecretKeyring => ({
    activeKeyId: active,
    keys: new Map(Object.entries(keys)),
    format: 'canonical',
  });

  it('never becomes the active key, whatever it is called', () => {
    const active = key();
    const keyring = new InstallationKeyring(configured({ 'kek-2': active }, 'kek-2'));
    keyring.replaceImported(new Map([['kek-1', key()]]));
    expect(keyring.activeKeyId).toBe('kek-2');
    expect(keyring.keys.has('kek-1')).toBe(true);
  });

  it('holds a different key under the ACTIVE id only as a decrypt candidate, never as the active key', () => {
    const active = key();
    const other = key();
    const keyring = new InstallationKeyring(configured({ 'kek-2': active }, 'kek-2'));
    // Two installations named their keys alike (the incident): held, tried AFTER.
    expect(keyring.replaceImported(new Map([['kek-2', other]]))).toEqual([]);
    expect(keyring.keys.get('kek-2')?.equals(active)).toBe(true);
    expect(keyring.activeKeyId).toBe('kek-2');
    expect(keyring.candidatesFor('kek-2').map((k) => k.equals(active))).toEqual([true, false]);
    const context = { purpose: 'bot_instance.token' as const, tenantId: 't', entityId: 'e' };
    const sealed = new AesGcmSecretCipher(keyring, false).encrypt('new', context);
    // Sealed under the CONFIGURED bytes: it opens with them alone.
    expect(
      new AesGcmSecretCipher(configured({ 'kek-2': active }, 'kek-2'), false).decrypt(
        sealed,
        context,
      ),
    ).toBe('new');
  });

  it('refuses an imported key that IS the configured key (same id, same bytes): never held twice', () => {
    const active = key();
    const keyring = new InstallationKeyring(configured({ 'kek-2': active }, 'kek-2'));
    expect(keyring.replaceImported(new Map([['kek-2', Buffer.from(active)]]))).toEqual(['kek-2']);
    expect(keyring.candidatesFor('kek-2')).toHaveLength(1);
  });

  it('encrypts under the configured key and decrypts under the imported one', () => {
    const old = key();
    const now = key();
    const context = { purpose: 'bot_instance.token' as const, tenantId: 't', entityId: 'e' };

    // A secret the OLD installation wrote, under its own key.
    const written = new AesGcmSecretCipher(configured({ 'kek-1': old }, 'kek-1'), false).encrypt(
      'the old bot token',
      context,
    );

    const keyring = new InstallationKeyring(configured({ 'kek-2': now }, 'kek-2'));
    const cipher = new AesGcmSecretCipher(keyring, false);
    // Before the kit: foreign.
    expect(syncCodeOf(() => cipher.decrypt(written, context))).toBe(
      PLATFORM_ERROR_CODES.SECRET_KEY_UNKNOWN,
    );
    keyring.replaceImported(new Map([['kek-1', old]]));
    expect(cipher.decrypt(written, context)).toBe('the old bot token');
    // And a NEW secret is sealed under the configured key, never the imported one.
    expect(cipher.encrypt('a new secret', context).keyId).toBe('kek-2');
  });

  it('drops a removed key from the keyring at the next load', () => {
    const keyring = new InstallationKeyring(configured({ 'kek-2': key() }, 'kek-2'));
    keyring.replaceImported(new Map([['kek-1', key()]]));
    keyring.replaceImported(new Map());
    expect(keyring.keys.has('kek-1')).toBe(false);
  });
});

describe('an imported key at rest', () => {
  it('unwraps only under its own id and its own wrapping key', () => {
    const wrapping = key();
    const material = key();
    const wrapped = wrapInstallationKey({
      keyId: 'kek-1',
      material,
      wrappingKeyId: 'kek-2',
      wrappingKey: wrapping,
    });
    expect(wrapped).not.toContain(material.toString('base64url'));
    const keys = new Map([['kek-2', wrapping]]);
    const fingerprint = kekFingerprint(material);
    expect(
      unwrapInstallationKey({ keyId: 'kek-1', wrapped, fingerprint, keys })?.equals(material),
    ).toBe(true);
    // Moved to another id: the associated data no longer matches.
    expect(unwrapInstallationKey({ keyId: 'kek-9', wrapped, fingerprint, keys })).toBeNull();
    // A fingerprint that is not this key's.
    expect(
      unwrapInstallationKey({ keyId: 'kek-1', wrapped, fingerprint: kekFingerprint(key()), keys }),
    ).toBeNull();
    // The wrapping key is gone.
    expect(
      unwrapInstallationKey({ keyId: 'kek-1', wrapped, fingerprint, keys: new Map() }),
    ).toBeNull();
  });

  it('resolves a second generation: a key wrapped under another imported key', () => {
    const configuredKey = key();
    const first = key();
    const second = key();
    const rows = [
      // Listed second-generation first, so one pass in order would miss it.
      {
        keyId: 'kek-0',
        fingerprint: kekFingerprint(second),
        wrappedMaterial: wrapInstallationKey({
          keyId: 'kek-0',
          material: second,
          wrappingKeyId: 'kek-1',
          wrappingKey: first,
        }),
      },
      {
        keyId: 'kek-1',
        fingerprint: kekFingerprint(first),
        wrappedMaterial: wrapInstallationKey({
          keyId: 'kek-1',
          material: first,
          wrappingKeyId: 'kek-2',
          wrappingKey: configuredKey,
        }),
      },
      {
        keyId: 'orphan',
        fingerprint: kekFingerprint(key()),
        wrappedMaterial: wrapInstallationKey({
          keyId: 'orphan',
          material: key(),
          wrappingKeyId: 'gone',
          wrappingKey: key(),
        }),
      },
    ];
    const { resolved, unavailable } = resolveStoredKeys(rows, new Map([['kek-2', configuredKey]]));
    expect([...resolved.keys()].sort()).toEqual(['kek-0', 'kek-1']);
    expect(resolved.get('kek-0')?.equals(second)).toBe(true);
    expect(unavailable).toEqual(['orphan']);
  });
});

// --- PR #144 review fixes ----------------------------------------------------

describe('a reload never disturbs a key already in use', () => {
  it('opens an archive sealed under an imported key while the keyring reloads mid-open', async () => {
    // The defect: `openArchive` fetches the KEK, awaits three file operations,
    // then unwraps. A reload in between used to ZERO the buffer it held, so the
    // unwrap ran under 32 zero bytes and a recovery failed for good.
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createHash } = await import('node:crypto');
    const { openArchive, sealArchive } =
      await import('../../apps/api/src/modules/platform/backup/infrastructure/archive');

    const imported = key();
    const keyring = new InstallationKeyring({
      activeKeyId: 'kek-2',
      keys: new Map([['kek-2', key()]]),
      format: 'canonical',
    });
    keyring.replaceImported(new Map([['kek-1', imported]]));

    const directory = await mkdtemp(join(tmpdir(), 'nexa-kit-reload-'));
    try {
      const payload = Buffer.from('PGDMP a dump');
      await writeFile(join(directory, 'dump'), payload);
      await sealArchive({
        dumpPath: join(directory, 'dump'),
        archivePath: join(directory, 'archive.nxb'),
        keyring: {
          activeKeyId: 'kek-1',
          keys: new Map([['kek-1', imported]]),
          format: 'canonical',
        },
        manifest: {
          manifestVersion: 1,
          backupId: '01a05e35-c9ad-7e93-bef3-1ed9b55292ff',
          installationId: 'old',
          createdAt: '2026-09-09T02:00:00.000Z',
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

      const opening = openArchive({
        archivePath: join(directory, 'archive.nxb'),
        dumpPath: join(directory, 'out'),
        keyring,
      });
      // A reload of the SAME keys, landing while the open is awaiting the file.
      setImmediate(() => keyring.replaceImported(new Map(keyring.importedKeys)));
      const opened = await opening;
      expect(opened.dumpChecksum).toBe(opened.manifest.checksum);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps the same buffer for an unchanged key across a reload', () => {
    const keyring = new InstallationKeyring({
      activeKeyId: 'kek-2',
      keys: new Map([['kek-2', key()]]),
      format: 'canonical',
    });
    keyring.replaceImported(new Map([['kek-1', key()]]));
    const held = keyring.keys.get('kek-1')!;
    const copy = Buffer.from(held);
    keyring.replaceImported(new Map(keyring.importedKeys));
    expect(keyring.keys.get('kek-1')).toBe(held);
    expect(held.equals(copy)).toBe(true);
  });
});

describe('an imported key at rest, against a truncated tag', () => {
  it('refuses a wrap whose authentication tag was shortened', () => {
    const wrapping = key();
    const material = key();
    const wrapped = wrapInstallationKey({
      keyId: 'kek-1',
      material,
      wrappingKeyId: 'kek-2',
      wrappingKey: wrapping,
    });
    const parts = wrapped.split('.');
    // The first 12 of the 16 tag bytes: a shorter tag is a weaker check, and a
    // decipher that inferred the length from the tag would accept it.
    parts[4] = Buffer.from(parts[4]!, 'base64url').subarray(0, 12).toString('base64url');
    expect(
      unwrapInstallationKey({
        keyId: 'kek-1',
        wrapped: parts.join('.'),
        fingerprint: kekFingerprint(material),
        keys: new Map([['kek-2', wrapping]]),
      }),
    ).toBeNull();
  });
});

describe('the key loader', () => {
  it('applies reloads in the order they were asked for, never an older read last', async () => {
    const { InstallationKeyLoader } =
      await import('../../apps/api/src/modules/platform/recovery/infrastructure/installation-key-adapters');
    const wrapping = key();
    const material = key();
    const row = {
      id: randomUUID(),
      keyId: 'kek-1',
      fingerprint: kekFingerprint(material),
      wrappedMaterial: wrapInstallationKey({
        keyId: 'kek-1',
        material,
        wrappingKeyId: 'kek-2',
        wrappingKey: wrapping,
      }),
      wrappedUnderKeyId: 'kek-2',
      source: 'RECOVERY_KIT' as const,
      kitId: null,
      importedAt: new Date(),
      importedByAdminId: null,
      importedByLabel: null,
      removedAt: null,
      removedByLabel: null,
      restoredAt: null,
    };
    // The first read is SLOW and sees the key; the second is fast and sees it
    // removed. Unserialised, the slow, older read finishes last and re-adds it.
    let calls = 0;
    const repository = {
      all: async () => {
        calls += 1;
        if (calls === 1) {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return [row];
        }
        return [];
      },
    };
    const keyring = new InstallationKeyring({
      activeKeyId: 'kek-2',
      keys: new Map([['kek-2', wrapping]]),
      format: 'canonical',
    });
    const loader = new InstallationKeyLoader(keyring, repository as never, {
      warn: () => undefined,
      error: () => undefined,
    });
    await Promise.all([loader.refresh(), loader.refresh()]);
    expect(keyring.keys.has('kek-1')).toBe(false);
  });

  it('makes a recovery FAIL when the keys cannot be reloaded, rather than run on stale keys', async () => {
    const { InstallationKeyLoader, KeyringRecoveryKeyCoverage } =
      await import('../../apps/api/src/modules/platform/recovery/infrastructure/installation-key-adapters');
    const keyring = new InstallationKeyring({
      activeKeyId: 'kek-2',
      keys: new Map([['kek-2', key()]]),
      format: 'canonical',
    });
    const broken = {
      all: async () => {
        throw new Error('the database went away');
      },
    };
    const loader = new InstallationKeyLoader(keyring, broken as never, {
      warn: () => undefined,
      error: () => undefined,
    });
    const coverage = new KeyringRecoveryKeyCoverage(keyring, loader, broken as never, {} as never);
    await expect(coverage.refresh()).rejects.toThrow('the database went away');
  });
});
