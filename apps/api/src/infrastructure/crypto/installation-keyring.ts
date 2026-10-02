import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { KeyringFormat, SecretKeyring } from './keyring.js';
import { kekFingerprint } from './recovery-kit.js';

/**
 * The keyring this installation actually decrypts with: its CONFIGURED keys,
 * plus the decrypt-only keys imported from Recovery Kits.
 *
 * It implements `SecretKeyring`, so `AesGcmSecretCipher` and the backup archive
 * read it exactly as they read the configured keyring — `keys.get(id)` at the
 * moment they need a key. That is the whole integration, and it is why an
 * imported key can open an old archive and decrypt a restored credential
 * without either of those code paths knowing kits exist.
 *
 * DECRYPT-ONLY IS STRUCTURAL, not a flag somebody checks. `activeKeyId` is the
 * configured keyring's and is read from nothing else; there is no setter, no
 * constructor argument and no code path that could make it name an imported
 * key. Both encrypting call sites (`AesGcmSecretCipher.encrypt`,
 * `sealArchive`) take the key by `activeKeyId`, so an imported key can be
 * HELD and never USED for new material.
 *
 * A CONFIGURED ID ALWAYS WINS. An imported key whose id collides with a
 * configured one is not loaded: import refuses that collision, but a restored
 * database can carry a row the current configuration contradicts, and the
 * configuration is the authority over what this installation's keys are.
 */
export class InstallationKeyring implements SecretKeyring {
  private merged: Map<string, Buffer>;
  private imported = new Map<string, Buffer>();

  constructor(private readonly configured: SecretKeyring) {
    this.merged = new Map(configured.keys);
  }

  get activeKeyId(): string {
    return this.configured.activeKeyId;
  }

  get format(): KeyringFormat {
    return this.configured.format;
  }

  /** Every key this installation can decrypt with. Read at the moment of use. */
  get keys(): ReadonlyMap<string, Buffer> {
    return this.merged;
  }

  /** The configured keys alone — what the server's configuration says. */
  get configuredKeys(): ReadonlyMap<string, Buffer> {
    return this.configured.keys;
  }

  /** The imported keys alone. */
  get importedKeys(): ReadonlyMap<string, Buffer> {
    return this.imported;
  }

  isConfigured(keyId: string): boolean {
    return this.configured.keys.has(keyId);
  }

  /**
   * Replaces the imported set, wholesale. Returns the ids it refused.
   *
   * Wholesale rather than incremental so a key REMOVED from the store leaves
   * the keyring at the next load, and a process never holds a key nobody can
   * see in the list.
   */
  replaceImported(next: ReadonlyMap<string, Buffer>): readonly string[] {
    const refused: string[] = [];
    const imported = new Map<string, Buffer>();
    for (const [keyId, material] of next) {
      if (this.configured.keys.has(keyId)) {
        refused.push(keyId);
        continue;
      }
      // An unchanged key keeps the SAME buffer it had, so a reload is invisible to
      // anything already holding it.
      const previous = this.imported.get(keyId);
      imported.set(
        keyId,
        previous !== undefined && previous.equals(material) ? previous : Buffer.from(material),
      );
    }
    const merged = new Map(this.configured.keys);
    for (const [keyId, material] of imported) merged.set(keyId, material);
    this.imported = imported;
    this.merged = merged;
    /*
     * The previous buffers are NOT zeroed, and that is the fix for a real defect
     * (PR #144 security review). A reader takes a key with `keys.get(id)` and may
     * use it after an await — `openArchive` reads the tag and opens the file
     * between fetching the KEK and unwrapping with it. Zeroing here, on a reload
     * the 60-second timer or any key list triggers, handed that reader 32 zero
     * bytes: an authentication failure and a recovery failed for good. A removed
     * key therefore lingers in this process's heap until it is collected; it is
     * gone from every map, from the database (its row is a tombstone) and from
     * every later lookup.
     */
    return refused;
  }
}

/**
 * How an imported key is stored at rest: wrapped under a CONFIGURED key.
 *
 *   ik1.<wrappingKeyId>.<iv>.<ciphertext>.<tag>     (base64url fields)
 *
 * AES-256-GCM, with `nexa.installation_key.v1|<keyId>|<wrappingKeyId>` as the
 * associated data — so a wrapped key copied onto another row, or relabelled to
 * claim a different wrapping key, fails the tag rather than unwrapping into the
 * wrong slot.
 *
 * Not `AesGcmSecretCipher`, deliberately. That cipher binds every value to a
 * TENANT, and these rows are installation-wide: a restore replaces the tenant
 * the row would have been bound to, while the key must survive it. And the
 * cipher reads the keyring this table feeds, so routing the table through it
 * would make the keyring depend on itself.
 */
const WRAP_VERSION = 'ik1';
const GCM_IV_BYTES = 12;

function wrapAad(keyId: string, wrappingKeyId: string): Buffer {
  return Buffer.from(`nexa.installation_key.v1|${keyId}|${wrappingKeyId}`, 'utf8');
}

export function wrapInstallationKey(input: {
  readonly keyId: string;
  readonly material: Buffer;
  readonly wrappingKeyId: string;
  readonly wrappingKey: Buffer;
}): string {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', input.wrappingKey, iv);
  cipher.setAAD(wrapAad(input.keyId, input.wrappingKeyId));
  const ciphertext = Buffer.concat([cipher.update(input.material), cipher.final()]);
  return [
    WRAP_VERSION,
    input.wrappingKeyId,
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.');
}

/** The wrapping key an envelope names, without unwrapping it. */
export function wrappingKeyIdOf(wrapped: string): string | null {
  const parts = wrapped.split('.');
  return parts.length === 5 && parts[0] === WRAP_VERSION ? (parts[1] ?? null) : null;
}

/**
 * Unwraps one stored key, or returns null.
 *
 * Null for every failure — an unknown wrapping key, a damaged envelope, a
 * fingerprint that is not the row's — because the caller's only decision is
 * "available or not", and the loader reports the id, never a reason derived
 * from OpenSSL's message.
 */
export function unwrapInstallationKey(input: {
  readonly keyId: string;
  readonly wrapped: string;
  readonly fingerprint: string;
  readonly keys: ReadonlyMap<string, Buffer>;
}): Buffer | null {
  const parts = input.wrapped.split('.');
  if (parts.length !== 5 || parts[0] !== WRAP_VERSION) return null;
  const [, wrappingKeyId, iv, ciphertext, tag] = parts as [string, string, string, string, string];
  const wrappingKey = input.keys.get(wrappingKeyId);
  if (wrappingKey === undefined) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', wrappingKey, Buffer.from(iv, 'base64url'), {
      authTagLength: 16,
    });
    decipher.setAAD(wrapAad(input.keyId, wrappingKeyId));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const material = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]);
    if (material.length !== 32 || kekFingerprint(material) !== input.fingerprint) {
      material.fill(0);
      return null;
    }
    return material;
  } catch {
    return null;
  }
}

/** A stored imported key, as the loader needs it. */
export interface StoredInstallationKey {
  readonly keyId: string;
  readonly fingerprint: string;
  /** Null on a tombstone: a removed key, kept so a restore cannot revive it. */
  readonly wrappedMaterial: string | null;
}

/**
 * Resolves every stored key that can be resolved, in as many passes as it takes.
 *
 * Several passes, because a restored database can hold a key wrapped under
 * ANOTHER imported key — the old installation imported a kit of its own, and
 * wrapped those keys under its then-active key, which is now itself imported
 * here. One pass would leave the second generation unavailable for no reason.
 * Terminates: every pass that continues has resolved at least one more row.
 */
export function resolveStoredKeys(
  rows: readonly StoredInstallationKey[],
  configured: ReadonlyMap<string, Buffer>,
): { readonly resolved: Map<string, Buffer>; readonly unavailable: readonly string[] } {
  const resolved = new Map<string, Buffer>();
  const pending = rows.filter((row) => !configured.has(row.keyId) && row.wrappedMaterial !== null);
  let progressed = true;
  while (progressed && pending.length > 0) {
    progressed = false;
    const available = new Map([...configured, ...resolved]);
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const row = pending[index]!;
      const material = unwrapInstallationKey({
        keyId: row.keyId,
        wrapped: row.wrappedMaterial ?? '',
        fingerprint: row.fingerprint,
        keys: available,
      });
      if (material === null) continue;
      resolved.set(row.keyId, material);
      pending.splice(index, 1);
      progressed = true;
    }
  }
  return { resolved, unavailable: pending.map((row) => row.keyId) };
}
