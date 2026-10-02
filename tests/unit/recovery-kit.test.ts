import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PLATFORM_ERROR_CODES, RECOVERY_KIT_MAGIC } from '@nexa/contracts';
import {
  FAST_KIT_KDF,
  kekFingerprint,
  openRecoveryKit,
  PRODUCTION_KIT_KDF,
  readRecoveryKitHeader,
  sealKitDocument,
  sealRecoveryKit,
} from '../../apps/api/src/infrastructure/crypto/recovery-kit';
import {
  InstallationKeyring,
  resolveStoredKeys,
  unwrapInstallationKey,
  wrapInstallationKey,
} from '../../apps/api/src/infrastructure/crypto/installation-keyring';
import { AesGcmSecretCipher } from '../../apps/api/src/infrastructure/crypto/secret-cipher';
import type { SecretKeyring } from '../../apps/api/src/infrastructure/crypto/keyring';

/**
 * The Recovery Kit format (ADR-0032, docs/recovery-kit-format.md), and the one
 * property everything else rests on: an imported key never encrypts.
 *
 * Every negative case the owner's specification lists for the FORMAT is here —
 * wrong passphrase, corrupted kit, wrong version, duplicate key ids. The ones
 * that need a database (collision against held keys, partial import, removal
 * with dependencies, missing required key) are in
 * `tests/integration/recovery-kit.test.ts`.
 */

const PASSPHRASE = 'correct horse battery staple';

const key = (): Buffer => randomBytes(32);

async function kitOf(
  keys: { keyId: string; material: Buffer }[],
  passphrase = PASSPHRASE,
): Promise<Buffer> {
  return sealRecoveryKit({
    keys,
    passphrase,
    profile: FAST_KIT_KDF,
    kitId: randomUUID(),
    createdAt: new Date('2026-10-02T10:00:00.000Z'),
  });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? 'no-code';
  }
  return 'did-not-throw';
}

function syncCodeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code ?? 'no-code';
  }
  return 'did-not-throw';
}

/** Rewrites the cleartext header JSON in place, keeping the rest of the file. */
function withHeader(kit: Buffer, edit: (header: Record<string, unknown>) => void): Buffer {
  const length = kit.readUInt32BE(8);
  const header = JSON.parse(kit.subarray(12, 12 + length).toString('utf8')) as Record<
    string,
    unknown
  >;
  edit(header);
  const bytes = Buffer.from(JSON.stringify(header), 'utf8');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([kit.subarray(0, 8), prefix, bytes, kit.subarray(12 + length)]);
}

describe('the Recovery Kit format', () => {
  it('round-trips every key, byte for byte, with its fingerprint', async () => {
    const a = key();
    const b = key();
    const kit = await kitOf([
      { keyId: 'prod-1', material: a },
      { keyId: 'prod-2', material: b },
    ]);
    expect(kit.subarray(0, 8).toString('ascii')).toBe(RECOVERY_KIT_MAGIC);

    const opened = await openRecoveryKit(kit, PASSPHRASE);
    expect(opened.keys.map((k) => k.keyId)).toEqual(['prod-1', 'prod-2']);
    expect(opened.keys[0]?.material.equals(a)).toBe(true);
    expect(opened.keys[1]?.material.equals(b)).toBe(true);
    expect(opened.keys[0]?.fingerprint).toBe(kekFingerprint(a));
  });

  it('never carries a key in the clear', async () => {
    const material = key();
    const kit = await kitOf([{ keyId: 'prod-1', material }]);
    expect(kit.includes(material)).toBe(false);
    expect(kit.toString('latin1')).not.toContain(material.toString('base64url'));
    expect(kit.toString('latin1')).not.toContain(material.toString('base64'));
    // The header names the KDF and nothing about the keys.
    expect(kit.toString('latin1')).not.toContain('prod-1');
  });

  it('embeds its KDF parameters in the authenticated header', async () => {
    const kit = await kitOf([{ keyId: 'k', material: key() }]);
    const { header } = readRecoveryKitHeader(kit);
    expect(header.kdf).toMatchObject({ algorithm: 'scrypt', log2N: 10, r: 8, p: 1 });
    expect(header.format).toBe(1);
  });

  it('writes production kits at the production cost', () => {
    // Fixed so a refactor cannot quietly weaken what every operator's kit is
    // sealed with. 2^17 with r = 8 is a login's memory; p = 4 is the extra work.
    expect(PRODUCTION_KIT_KDF).toEqual({ log2N: 17, r: 8, p: 4 });
  });

  // --- The owner's negative cases -----------------------------------------

  it('refuses the WRONG PASSPHRASE with the one authentication code', async () => {
    const kit = await kitOf([{ keyId: 'k', material: key() }]);
    expect(await codeOf(openRecoveryKit(kit, 'not the passphrase at all'))).toBe(
      PLATFORM_ERROR_CODES.RECOVERY_KIT_AUTH_FAILED,
    );
  });

  it('refuses a CORRUPTED kit — ciphertext, tag or header — and cannot tell which', async () => {
    const kit = await kitOf([{ keyId: 'k', material: key() }]);
    const headerEnd = 12 + kit.readUInt32BE(8);

    const body = Buffer.from(kit);
    body[headerEnd + 3] = (body[headerEnd + 3] ?? 0) ^ 0x01;
    const tag = Buffer.from(kit);
    tag[tag.length - 1] = (tag[tag.length - 1] ?? 0) ^ 0x80;
    // A header edit that still parses: a different nonce. Authenticated, so it
    // fails the tag rather than steering the decryption.
    const header = withHeader(kit, (h) => {
      h.iv = randomBytes(12).toString('base64url');
    });

    for (const damaged of [body, tag, header]) {
      // The SAME code as a wrong passphrase. An error that said which would be
      // an oracle for the passphrase.
      expect(await codeOf(openRecoveryKit(damaged, PASSPHRASE))).toBe(
        PLATFORM_ERROR_CODES.RECOVERY_KIT_AUTH_FAILED,
      );
    }
  });

  it('refuses a truncated kit, and a file that is not a kit at all', async () => {
    const kit = await kitOf([{ keyId: 'k', material: key() }]);
    expect(await codeOf(openRecoveryKit(kit.subarray(0, 20), PASSPHRASE))).toBe(
      PLATFORM_ERROR_CODES.RECOVERY_KIT_MALFORMED,
    );
    expect(await codeOf(openRecoveryKit(Buffer.from('NEXABAK1 not a kit'), PASSPHRASE))).toBe(
      PLATFORM_ERROR_CODES.RECOVERY_KIT_MALFORMED,
    );
    // Cut inside the payload: the header parses, the tag is wrong.
    expect(await codeOf(openRecoveryKit(kit.subarray(0, kit.length - 5), PASSPHRASE))).toBe(
      PLATFORM_ERROR_CODES.RECOVERY_KIT_AUTH_FAILED,
    );
  });

  it('refuses a WRONG VERSION by name, before deriving anything', async () => {
    const kit = await kitOf([{ keyId: 'k', material: key() }]);
    const future = withHeader(kit, (h) => {
      h.format = 2;
    });
    expect(syncCodeOf(() => readRecoveryKitHeader(future))).toBe(
      PLATFORM_ERROR_CODES.RECOVERY_KIT_UNSUPPORTED_VERSION,
    );
    expect(await codeOf(openRecoveryKit(future, PASSPHRASE))).toBe(
      PLATFORM_ERROR_CODES.RECOVERY_KIT_UNSUPPORTED_VERSION,
    );
  });

  it('refuses KDF parameters a hostile header could use to exhaust memory', async () => {
    const kit = await kitOf([{ keyId: 'k', material: key() }]);
    for (const edit of [
      (h: Record<string, unknown>) => ((h.kdf as Record<string, unknown>).log2N = 30),
      (h: Record<string, unknown>) => ((h.kdf as Record<string, unknown>).r = 1024),
      (h: Record<string, unknown>) => ((h.kdf as Record<string, unknown>).p = 1000),
      (h: Record<string, unknown>) => ((h.kdf as Record<string, unknown>).algorithm = 'pbkdf2'),
    ]) {
      // MALFORMED from the header alone: the derivation is never attempted, so
      // the allocation it would have asked for never happens.
      expect(syncCodeOf(() => readRecoveryKitHeader(withHeader(kit, edit)))).toBe(
        PLATFORM_ERROR_CODES.RECOVERY_KIT_MALFORMED,
      );
    }
  });

  it('refuses DUPLICATE KEY IDS, even in a kit that authenticates', async () => {
    // Sealed with the passphrase, so the only thing wrong is the content. A
    // reader that took the last (or the first) would be choosing which of two
    // different keys a name "means".
    const kitId = randomUUID();
    const a = key();
    const b = key();
    const kit = await sealKitDocument({
      payload: {
        format: 1,
        kitId,
        keys: [
          { keyId: 'dup', material: a.toString('base64url'), fingerprint: kekFingerprint(a) },
          { keyId: 'dup', material: b.toString('base64url'), fingerprint: kekFingerprint(b) },
        ],
      },
      passphrase: PASSPHRASE,
      profile: FAST_KIT_KDF,
      kitId,
      createdAt: new Date(),
    });
    expect(await codeOf(openRecoveryKit(kit, PASSPHRASE))).toBe(
      PLATFORM_ERROR_CODES.RECOVERY_KIT_MALFORMED,
    );
    // And the writer refuses to produce one in the first place.
    expect(
      await codeOf(
        kitOf([
          { keyId: 'dup', material: a },
          { keyId: 'dup', material: b },
        ]),
      ),
    ).toBe(PLATFORM_ERROR_CODES.RECOVERY_KIT_MALFORMED);
  });

  it('refuses a kit that asks for a key to be ACTIVE — the format cannot express it', async () => {
    const kitId = randomUUID();
    const a = key();
    const kit = await sealKitDocument({
      payload: {
        format: 1,
        kitId,
        keys: [
          {
            keyId: 'k',
            material: a.toString('base64url'),
            fingerprint: kekFingerprint(a),
            active: true,
          },
        ],
      },
      passphrase: PASSPHRASE,
      profile: FAST_KIT_KDF,
      kitId,
      createdAt: new Date(),
    });
    expect(await codeOf(openRecoveryKit(kit, PASSPHRASE))).toBe(
      PLATFORM_ERROR_CODES.RECOVERY_KIT_MALFORMED,
    );
  });

  it('refuses a key that does not match its own fingerprint', async () => {
    const kitId = randomUUID();
    const a = key();
    const kit = await sealKitDocument({
      payload: {
        format: 1,
        kitId,
        keys: [
          { keyId: 'k', material: a.toString('base64url'), fingerprint: kekFingerprint(key()) },
        ],
      },
      passphrase: PASSPHRASE,
      profile: FAST_KIT_KDF,
      kitId,
      createdAt: new Date(),
    });
    expect(await codeOf(openRecoveryKit(kit, PASSPHRASE))).toBe(
      PLATFORM_ERROR_CODES.RECOVERY_KIT_MALFORMED,
    );
  });

  it('refuses a payload moved in from a different kit', async () => {
    const a = key();
    const kit = await sealKitDocument({
      payload: {
        format: 1,
        kitId: randomUUID(),
        keys: [{ keyId: 'k', material: a.toString('base64url'), fingerprint: kekFingerprint(a) }],
      },
      passphrase: PASSPHRASE,
      profile: FAST_KIT_KDF,
      kitId: randomUUID(),
      createdAt: new Date(),
    });
    expect(await codeOf(openRecoveryKit(kit, PASSPHRASE))).toBe(
      PLATFORM_ERROR_CODES.RECOVERY_KIT_MALFORMED,
    );
  });

  it('refuses to seal under a short or space-padded passphrase', async () => {
    expect(await codeOf(kitOf([{ keyId: 'k', material: key() }], 'short'))).toBe(
      PLATFORM_ERROR_CODES.RECOVERY_KIT_PASSPHRASE_REJECTED,
    );
    expect(await codeOf(kitOf([{ keyId: 'k', material: key() }], ` ${PASSPHRASE}`))).toBe(
      PLATFORM_ERROR_CODES.RECOVERY_KIT_PASSPHRASE_REJECTED,
    );
  });

  it('opens with the same passphrase typed in a different Unicode normal form', async () => {
    // «é» precomposed and decomposed are two code-point sequences for one text.
    const composed = 'café au lait every morning';
    const decomposed = 'café au lait every morning';
    const material = key();
    const kit = await kitOf([{ keyId: 'k', material }], composed);
    const opened = await openRecoveryKit(kit, decomposed);
    expect(opened.keys[0]?.material.equals(material)).toBe(true);
  });
});

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

  it('refuses an imported key that claims the ACTIVE key id, and keeps the configured bytes', () => {
    const active = key();
    const impostor = key();
    const keyring = new InstallationKeyring(configured({ 'kek-2': active }, 'kek-2'));
    const refused = keyring.replaceImported(new Map([['kek-2', impostor]]));
    expect(refused).toEqual(['kek-2']);
    expect(keyring.keys.get('kek-2')?.equals(active)).toBe(true);
    expect(keyring.activeKeyId).toBe('kek-2');
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

describe('a kit derivation is bounded', () => {
  it('runs at most one at a time in a process, refusing the second as BUSY', async () => {
    const kit = await kitOf([{ keyId: 'k', material: key() }]);
    const [first, second] = await Promise.allSettled([
      openRecoveryKit(kit, PASSPHRASE),
      openRecoveryKit(kit, PASSPHRASE),
    ]);
    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('rejected');
    expect((second as PromiseRejectedResult).reason.code).toBe(
      PLATFORM_ERROR_CODES.RECOVERY_KIT_BUSY,
    );
    // And it is free again afterwards.
    await expect(openRecoveryKit(kit, PASSPHRASE)).resolves.toBeDefined();
  });

  it('refuses p above 4 from the header alone', async () => {
    const kit = await kitOf([{ keyId: 'k', material: key() }]);
    const hostile = withHeader(kit, (h) => {
      (h.kdf as Record<string, unknown>).p = 5;
    });
    expect(syncCodeOf(() => readRecoveryKitHeader(hostile))).toBe(
      PLATFORM_ERROR_CODES.RECOVERY_KIT_MALFORMED,
    );
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
