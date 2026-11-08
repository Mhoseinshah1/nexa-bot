/**
 * The key-encryption keys this installation holds.
 *
 * v1 configured exactly one KEK and refused any ciphertext naming a different
 * key id, so rotating the key made every existing row permanently unreadable.
 * The `key_id` column recorded which key was used and nothing could act on it.
 *
 * A keyring separates the two questions that were conflated:
 *
 *   - which key do we ENCRYPT with — exactly one, the active key;
 *   - which keys may we DECRYPT with — all of them.
 *
 * That is what makes rotation a period of overlap rather than a flag day, and
 * it is the precondition for re-encrypting rows in bounded batches instead of
 * all at once.
 *
 * Parsing lives here, and the config schema calls it, so the validation an
 * operator sees at boot and the resolution the container performs cannot
 * drift apart into two nearly-identical implementations.
 */

/** A key id is a label, and labels appear in AEAD associated data. Keep it narrow. */
const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;
const KEY_BYTES = 32;

/**
 * Which spelling the host's configuration uses.
 *
 * Not cosmetic, and not a nicety for the status report: it is the ONLY evidence
 * on a host that says whether that installation predates the v2 envelope.
 *
 * `SECRETS_KEYS` can have been written by exactly two things — the installer of
 * a keyring-era release, or `botctl secrets migrate-config`. Both are v2-era.
 * `SECRETS_KEK` can only have been written by an installer that shipped before
 * v2 existed, which is precisely the population that may hold v1 ciphertext.
 *
 * That is what lets v1 acceptance default to OFF without breaking the hosts
 * that need it on. See `SECRETS_ACCEPT_V1` in the config schema.
 */
export type KeyringFormat = 'canonical' | 'legacy';

export interface SecretKeyring {
  readonly activeKeyId: string;
  /**
   * One key per id: the one an id RESOLVES to for encryption and for display — the
   * configured key when one is configured under that id. Decryption does not read
   * this map directly: it asks `heldKeysFor`, because an id can name more than one
   * held key (below).
   */
  readonly keys: ReadonlyMap<string, Buffer>;
  readonly format: KeyringFormat;
  /**
   * EVERY held key answering to `keyId`, in the order decryption tries them: the
   * configured key first, then imported decrypt-only keys, then keys held for one
   * recovery only. Absent on a plain configured keyring, where an id names one key.
   *
   * Why an id can name several: key ids are labels, and two installations made on
   * the same day were both labelled `install-<date>` with DIFFERENT material. A
   * backup of one restored on the other names a key this side holds by name and not
   * by bytes. Authenticated decryption is what tells which key is the right one, so
   * every candidate is tried and only an authenticated success is ever returned.
   */
  candidatesFor?(keyId: string): readonly Buffer[];
}

/**
 * Every held key a ciphertext naming `keyId` may have been sealed under, in trial
 * order (see `SecretKeyring.candidatesFor`). Empty when none is held.
 */
export function heldKeysFor(keyring: SecretKeyring, keyId: string): readonly Buffer[] {
  if (keyring.candidatesFor !== undefined) return keyring.candidatesFor(keyId);
  const key = keyring.keys.get(keyId);
  return key === undefined ? [] : [key];
}

/** One extra decrypt-only key: an id and its 32 bytes. */
export interface ExtraKey {
  readonly keyId: string;
  readonly material: Buffer;
}

/**
 * `base`, plus `extra` decrypt-only keys tried AFTER every key `base` holds under the
 * same id. For one recovery's lifetime: the keys a self-contained archive carried.
 *
 * Decrypt-only by construction, exactly as `InstallationKeyring` is: `activeKeyId`
 * is `base`'s and `keys` resolves an id to `base`'s key whenever `base` holds one,
 * so the active key — the only key anything encrypts with — can never be an extra.
 * The extras are not copied: the caller owns their buffers and zeroes them.
 */
export function withExtraKeys(base: SecretKeyring, extra: readonly ExtraKey[]): SecretKeyring {
  if (extra.length === 0) return base;
  const keys = new Map(base.keys);
  for (const key of extra) if (!keys.has(key.keyId)) keys.set(key.keyId, key.material);
  return {
    get activeKeyId() {
      return base.activeKeyId;
    },
    get format() {
      return base.format;
    },
    keys,
    candidatesFor(keyId: string): readonly Buffer[] {
      const held = [...heldKeysFor(base, keyId)];
      for (const key of extra) {
        if (key.keyId !== keyId) continue;
        if (held.some((candidate) => candidate.equals(key.material))) continue;
        held.push(key.material);
      }
      return held;
    },
  };
}

/**
 * A keyring holding exactly one key — `keyring`'s ACTIVE key — and nothing else.
 *
 * For the proof after a pre-cutover rewrap: every secret in the candidate must read
 * under the active key ALONE, or something still depends on a key that will be
 * gone once the recovery's extra keys are dropped.
 */
export function activeKeyOnly(keyring: SecretKeyring): SecretKeyring {
  const active = keyring.keys.get(keyring.activeKeyId);
  const keys = new Map<string, Buffer>();
  if (active !== undefined) keys.set(keyring.activeKeyId, active);
  return { activeKeyId: keyring.activeKeyId, format: keyring.format, keys };
}

export interface KeyringInput {
  readonly SECRETS_KEYS?: string | undefined;
  readonly SECRETS_ACTIVE_KEY_ID?: string | undefined;
  readonly SECRETS_KEK?: string | undefined;
  readonly SECRETS_KEK_ID?: string | undefined;
}

export type KeyringResult =
  | { readonly ok: true; readonly keyring: SecretKeyring }
  | { readonly ok: false; readonly problems: readonly string[] };

function keyProblem(id: string, value: string): string | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return `key "${id}" is not valid base64`;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== KEY_BYTES) {
    return `key "${id}" must decode to exactly ${KEY_BYTES} bytes, not ${bytes.length}`;
  }
  if (bytes.every((byte) => byte === 0)) return `key "${id}" is all zero bytes`;
  return null;
}

/**
 * `id:base64,id:base64` — one line, appendable by hand and by the installer.
 *
 * Not JSON: `/etc/nexa/nexa.env` is `KEY=value` lines, and a JSON value there
 * needs quoting rules that an operator adding a second key during a rotation
 * would have to get right under pressure. The id grammar forbids `:` and `,`,
 * so this grammar is unambiguous rather than merely usually-fine.
 */
export function parseKeyring(input: KeyringInput): KeyringResult {
  const problems: string[] = [];
  const keys = new Map<string, Buffer>();

  const raw = (input.SECRETS_KEYS ?? '').trim();
  const legacyKey = (input.SECRETS_KEK ?? '').trim();
  const legacyId = (input.SECRETS_KEK_ID ?? '').trim();

  // Decided by which spelling is PRESENT, before any of it is validated —
  // SECRETS_KEYS wins when both are, exactly as the parsing below does. A
  // format derived from whichever branch happened to succeed would call a host
  // canonical because its legacy pair was malformed.
  const format: KeyringFormat = raw.length > 0 ? 'canonical' : 'legacy';

  if (raw.length > 0) {
    for (const entry of raw.split(',')) {
      const trimmed = entry.trim();
      if (trimmed.length === 0) continue;
      const separator = trimmed.indexOf(':');
      if (separator <= 0) {
        problems.push(`"${trimmed.slice(0, 24)}…" is not an id:key pair`);
        continue;
      }
      const id = trimmed.slice(0, separator);
      const value = trimmed.slice(separator + 1);
      if (!KEY_ID.test(id)) {
        problems.push(`key id "${id}" must be 1-64 of letters, digits, dot, underscore or hyphen`);
        continue;
      }
      // Duplicates are refused rather than last-wins. Last-wins means an
      // operator appending a rotated key under a name already in use silently
      // replaces the key that existing rows need.
      if (keys.has(id)) {
        problems.push(`key id "${id}" appears more than once`);
        continue;
      }
      const problem = keyProblem(id, value);
      if (problem !== null) {
        problems.push(problem);
        continue;
      }
      keys.set(id, Buffer.from(value, 'base64'));
    }
  } else if (legacyKey.length > 0 || legacyId.length > 0) {
    // The installations that already exist.
    //
    // Every host installed before this release has SECRETS_KEK and
    // SECRETS_KEK_ID and nothing else, and adopting v2 must not require a
    // reinstall or a hand-edit of /etc/nexa/nexa.env. They alias to a one-entry
    // keyring whose only key is active, which is exactly what v1 did.
    if (legacyId.length === 0) problems.push('SECRETS_KEK is set but SECRETS_KEK_ID is not');
    else if (!KEY_ID.test(legacyId))
      problems.push(`SECRETS_KEK_ID "${legacyId}" is not a valid id`);
    if (legacyKey.length === 0) problems.push('SECRETS_KEK_ID is set but SECRETS_KEK is not');
    else {
      const problem = keyProblem(legacyId || 'SECRETS_KEK', legacyKey);
      if (problem !== null) problems.push(problem);
      else if (problems.length === 0) keys.set(legacyId, Buffer.from(legacyKey, 'base64'));
    }
  } else {
    problems.push('no secret keys are configured: set SECRETS_KEYS (or the legacy SECRETS_KEK)');
  }

  const activeKeyId =
    (input.SECRETS_ACTIVE_KEY_ID ?? '').trim() ||
    // With one key and no explicit choice there is nothing to choose. With
    // several there is, and guessing would make the encryption key depend on
    // the order somebody typed them in.
    (keys.size === 1 ? [...keys.keys()][0]! : '');

  if (activeKeyId.length === 0) {
    problems.push(
      'SECRETS_ACTIVE_KEY_ID is required when more than one key is configured: it decides which ' +
        'key new secrets are encrypted with, and the order of SECRETS_KEYS must not decide that.',
    );
  } else if (!keys.has(activeKeyId) && problems.length === 0) {
    problems.push(
      `SECRETS_ACTIVE_KEY_ID "${activeKeyId}" names no configured key. New secrets would be ` +
        'encrypted with a key nothing holds.',
    );
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, keyring: { activeKeyId, keys, format } };
}
