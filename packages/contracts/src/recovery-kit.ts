import { z } from 'zod';

/**
 * The Recovery Kit — what makes a `.nxb` restorable on an installation that did
 * not write it.
 *
 * An archive's data key is wrapped under the key-encryption key (KEK) of the
 * installation that sealed it. A host rebuilt from scratch gets a NEW KEK from
 * its installer, so the archive copied off the old host fails at the key —
 * `recovery.archive_foreign_key` — and before this contract there was no way
 * back short of recovering the old `/etc/nexa/nexa.env` by hand.
 *
 * The kit is that way back, and its shape is driven by three refusals:
 *
 *   - **No raw KEK travels anywhere.** Not inside the `.nxb` (a backup that
 *     carries its own key is not encrypted), not in a form field, not in a URL.
 *     The kit is a separate file, sealed under a key DERIVED from a passphrase
 *     the operator chose, and the server holds the passphrase only for the
 *     length of one request.
 *   - **An imported key never encrypts.** It is DECRYPT-ONLY by construction:
 *     the active key comes from the installation's configuration and from
 *     nowhere else, and the kit format has no field that could ask otherwise.
 *     The payload schema below is `strict`, so a kit naming a role, a flag or an
 *     "active" marker is refused as malformed rather than half-honoured.
 *   - **A key is removed only when nothing retained needs it.** Removal is
 *     refused while any stored secret, any other imported key, any retained
 *     local archive or any live recovery depends on it.
 *
 * See docs/adr/0032-recovery-kit.md and docs/recovery-kit-format.md.
 *
 * THE FILE LAYOUT (format 1)
 *
 *   magic          8 bytes, ASCII `NEXAKIT1`
 *   headerLength   uint32 big-endian
 *   header         `headerLength` bytes of UTF-8 JSON, `recoveryKitHeaderSchema`
 *   ciphertext     AES-256-GCM over the UTF-8 JSON payload, `recoveryKitPayloadSchema`
 *   tag            16 bytes, the GCM authentication tag
 *
 * The header (magic and length included) is the payload's associated data, so
 * the KDF parameters, the salt, the nonce and the format version are all
 * authenticated: editing any of them fails the tag rather than steering the
 * derivation.
 */

/** The eight ASCII bytes every kit begins with. */
export const RECOVERY_KIT_MAGIC = 'NEXAKIT1';
/** The one format this release writes and reads. A different value is refused, never guessed. */
export const RECOVERY_KIT_FORMAT_VERSION = 1;
/** What the Web Admin names the downloaded file. Cosmetic: nothing reads the extension. */
export const RECOVERY_KIT_FILE_EXTENSION = '.nxkit';
/**
 * A kit larger than this is not a kit.
 *
 * Sixty-four keys of a few hundred bytes each is under 32 KiB; the ceiling bounds
 * what a request body and a parser are made to hold before anything is
 * authenticated.
 */
export const RECOVERY_KIT_MAX_BYTES = 256 * 1024;
/** How many keys one kit may carry. More is a malformed kit, not a large one. */
export const RECOVERY_KIT_MAX_KEYS = 64;

/**
 * The passphrase rule, in code points after NFC normalisation.
 *
 * Twelve is a floor and not advice: the kit is an offline target, so the
 * passphrase is the only thing between whoever holds the file and every KEK in
 * it. The KDF makes each guess expensive; it cannot make a short passphrase long.
 */
export const RECOVERY_KIT_PASSPHRASE_MIN_LENGTH = 12;
export const RECOVERY_KIT_PASSPHRASE_MAX_LENGTH = 1024;

/**
 * The KDF parameters a reader ACCEPTS. Bounds against a hostile file, not advice.
 *
 * The header is read before anything is authenticated, so every number in it is
 * attacker-chosen until the tag verifies — and `N` decides how much memory the
 * derivation allocates. The upper bounds are what stop a crafted kit from asking
 * the server for gigabytes; the lower bounds stop nothing an attacker wants (a
 * weak kit they crafted protects only their own key) and exist so a reader never
 * attempts a derivation too cheap to have been written by this code.
 */
export const RECOVERY_KIT_KDF_BOUNDS = {
  minLog2N: 10,
  /**
   * 2^18 with r = 8 is 256 MiB for one derivation, which is the most a crafted
   * header may make this server allocate. The writer's own profile is 2^17 with
   * p = 4: the same memory as a login, four times the work.
   */
  maxLog2N: 18,
  minR: 8,
  maxR: 8,
  minP: 1,
  /**
   * 4, the writer's own value: the work a crafted header may demand per
   * derivation is bounded too, not only the memory. (Was 8; lowered after the
   * PR #144 security review. A kit at p = 8 was never written by this code.) The
   * server also runs at most ONE kit derivation at a time per process.
   */
  maxP: 4,
} as const;

/**
 * Argon2id was the owner's first named choice and is NOT what format 1 uses.
 *
 * Node 22 — the runtime this image pins — has scrypt in its standard library and
 * no Argon2; every Argon2 binding is a native build or a single-maintainer
 * prebuilt, and neither is in this repository's lockfile. scrypt is memory-hard
 * and is what `ScryptPasswordHasher` already relies on. The algorithm is NAMED in
 * the authenticated header, so a later `argon2id` is a new branch in the reader,
 * not a new format. ADR-0032 records the deviation.
 */
export const RECOVERY_KIT_KDF_ALGORITHMS = ['scrypt'] as const;
export type RecoveryKitKdfAlgorithm = (typeof RECOVERY_KIT_KDF_ALGORITHMS)[number];

/**
 * Unpadded base64url carrying between `min` and `max` bytes.
 *
 * Counted from the string rather than by decoding, because this file is shared
 * with the browser and has no `Buffer`. Unpadded base64url encodes `n` bytes in
 * `ceil(4n / 3)` characters, and a length of `1 mod 4` is never produced.
 */
const base64url = (min: number, max: number) =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .refine((value) => {
      if (value.length % 4 === 1) return false;
      const bytes = Math.floor((value.length * 3) / 4);
      return bytes >= min && bytes <= max;
    }, 'wrong length');

/** A key label. The same grammar `SECRETS_KEYS` enforces at boot. */
export const installationKeyIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);

/**
 * A key's FINGERPRINT: the first 32 hex digits of
 * SHA-256("nexa.kek.fingerprint.v1\n" || key).
 *
 * Safe to show and to audit: recovering a 256-bit key from a truncated hash of
 * it is not a thing anybody can do. It is how an operator compares "the key this
 * kit holds" with "the key the old server had" without either being shown.
 */
export const installationKeyFingerprintSchema = z.string().regex(/^[0-9a-f]{32}$/);

export const recoveryKitHeaderSchema = z
  .object({
    format: z.literal(RECOVERY_KIT_FORMAT_VERSION),
    kitId: z.string().uuid(),
    createdAt: z.iso.datetime(),
    kdf: z
      .object({
        algorithm: z.enum(RECOVERY_KIT_KDF_ALGORITHMS),
        log2N: z
          .number()
          .int()
          .min(RECOVERY_KIT_KDF_BOUNDS.minLog2N)
          .max(RECOVERY_KIT_KDF_BOUNDS.maxLog2N),
        r: z.number().int().min(RECOVERY_KIT_KDF_BOUNDS.minR).max(RECOVERY_KIT_KDF_BOUNDS.maxR),
        p: z.number().int().min(RECOVERY_KIT_KDF_BOUNDS.minP).max(RECOVERY_KIT_KDF_BOUNDS.maxP),
        salt: base64url(16, 64),
      })
      .strict(),
    cipher: z.literal('aes-256-gcm'),
    iv: base64url(12, 12),
  })
  .strict();
export type RecoveryKitHeader = z.infer<typeof recoveryKitHeaderSchema>;

/**
 * One key inside the encrypted payload.
 *
 * No `active`, no `role`, no `usage` — and `strict`, so a kit carrying one is
 * malformed. Whether a key encrypts is decided by the installation's
 * configuration alone; a file must not be able to so much as express a wish.
 */
export const recoveryKitKeySchema = z
  .object({
    keyId: installationKeyIdSchema,
    /** The 32-byte KEK, base64url. The only place key bytes exist outside a keyring. */
    material: base64url(32, 32),
    fingerprint: installationKeyFingerprintSchema,
  })
  .strict();
export type RecoveryKitKey = z.infer<typeof recoveryKitKeySchema>;

export const recoveryKitPayloadSchema = z
  .object({
    format: z.literal(RECOVERY_KIT_FORMAT_VERSION),
    /** Repeated from the header and compared, so a payload cannot be moved into another kit. */
    kitId: z.string().uuid(),
    keys: z.array(recoveryKitKeySchema).min(1).max(RECOVERY_KIT_MAX_KEYS),
  })
  .strict();
export type RecoveryKitPayload = z.infer<typeof recoveryKitPayloadSchema>;

/**
 * Where a key this installation holds came from, and therefore what it may do.
 *
 *   `CONFIGURED_ACTIVE`  the one key new secrets and new archives are sealed
 *                        with. From `SECRETS_ACTIVE_KEY_ID` / `SECRETS_KEK_ID`.
 *   `CONFIGURED`         another key in `SECRETS_KEYS`: a rotation's overlap.
 *   `IMPORTED`           from a Recovery Kit. DECRYPT-ONLY, always.
 *
 * Only `IMPORTED` keys are managed from the Web Admin. A configured key lives in
 * the server's configuration, and changing that is a host operation.
 */
export const INSTALLATION_KEY_ORIGINS = ['CONFIGURED_ACTIVE', 'CONFIGURED', 'IMPORTED'] as const;
export type InstallationKeyOrigin = (typeof INSTALLATION_KEY_ORIGINS)[number];

/** Where an imported key came from. One source today; a column, so it can grow. */
export const INSTALLATION_KEY_SOURCES = ['RECOVERY_KIT'] as const;
export type InstallationKeySource = (typeof INSTALLATION_KEY_SOURCES)[number];

/**
 * What still needs a key. Every field is a COUNT.
 *
 * `secrets`           stored credentials whose envelope names this key.
 * `wrappedKeys`       other imported keys stored wrapped under this one.
 * `retainedArchives`  encrypted archives on this server's disk sealed under it, OR
 *                     taken while it was held — such a backup may carry secrets
 *                     sealed under it that its own header cannot reveal.
 * `openRecoveries`    recoveries not yet finished whose upload is sealed under it.
 *
 * A copy of an archive somewhere else — a Telegram chat, a laptop — is not
 * countable from here, and the removal confirmation says so.
 */
export const installationKeyDependenciesSchema = z.object({
  secrets: z.number().int().nonnegative(),
  wrappedKeys: z.number().int().nonnegative(),
  retainedArchives: z.number().int().nonnegative(),
  openRecoveries: z.number().int().nonnegative(),
});
export type InstallationKeyDependencies = z.infer<typeof installationKeyDependenciesSchema>;

export const installationKeySummarySchema = z.object({
  keyId: installationKeyIdSchema,
  /**
   * Null for a CONFIGURED key unless the reader may export the kit: the list is
   * readable with LOW `backup.view`, and a fingerprint of the server's own keys
   * is for the people who hold them.
   */
  fingerprint: installationKeyFingerprintSchema.nullable(),
  origin: z.enum(INSTALLATION_KEY_ORIGINS),
  /** `true` for exactly one key: the configured active one. Never for an imported key. */
  encrypts: z.boolean(),
  importedAt: z.iso.datetime().nullable(),
  importedBy: z.string().nullable(),
  /**
   * An imported row this installation cannot currently unwrap — its wrapping key
   * is gone. Reported so it is visible, never silently dropped.
   */
  available: z.boolean(),
  dependencies: installationKeyDependenciesSchema,
  /**
   * The key was not imported here: it came back inside a RESTORED backup. Flagged
   * (and audited at the cutover) so a key nobody imported on this server is
   * visible as such.
   */
  arrivedByRestore: z.boolean(),
  /** Only an imported key with no dependency. Configured keys are never removable here. */
  removable: z.boolean(),
});
export type InstallationKeySummary = z.infer<typeof installationKeySummarySchema>;

export const installationKeysResponseSchema = z.object({
  keys: z.array(installationKeySummarySchema),
});
export type InstallationKeysResponse = z.infer<typeof installationKeysResponseSchema>;

/**
 * Exporting a kit. The most sensitive read in the product: it hands every KEK
 * this installation holds to whoever knows the passphrase.
 *
 * Three proofs on top of the CRITICAL permission: the administrator's own
 * account password (a stolen session alone is not enough), and the passphrase
 * twice (so a typo does not produce a kit nobody can open). None of the three is
 * stored, logged or audited.
 */
export const exportRecoveryKitRequestSchema = z
  .object({
    accountPassword: z.string().min(1).max(1024),
    passphrase: z.string().max(RECOVERY_KIT_PASSPHRASE_MAX_LENGTH),
    passphraseConfirmation: z.string().max(RECOVERY_KIT_PASSPHRASE_MAX_LENGTH),
  })
  .strict();
export type ExportRecoveryKitRequest = z.infer<typeof exportRecoveryKitRequestSchema>;

/** The kit travels as base64 inside JSON: one small file, and no multipart parser. */
export const importRecoveryKitRequestSchema = z
  .object({
    kit: z
      .string()
      .max(Math.ceil((RECOVERY_KIT_MAX_BYTES * 4) / 3) + 4)
      .regex(/^[A-Za-z0-9+/_=-]+$/),
    passphrase: z.string().max(RECOVERY_KIT_PASSPHRASE_MAX_LENGTH),
    /**
     * Step-up, as on export. A stolen owner session must not be able to import a
     * key of its own choosing: with one, a forged archive sealed under it would
     * open here and could be restored.
     */
    accountPassword: z.string().min(1).max(1024),
    idempotencyKey: z.string().min(8).max(255),
  })
  .strict();
export type ImportRecoveryKitRequest = z.infer<typeof importRecoveryKitRequestSchema>;

export const importRecoveryKitResponseSchema = z.object({
  kitId: z.string().uuid(),
  /** Keys this import added, decrypt-only. */
  imported: z.array(
    z.object({ keyId: installationKeyIdSchema, fingerprint: installationKeyFingerprintSchema }),
  ),
  /** Keys the installation already held with the same bytes. Nothing was written for them. */
  alreadyHeld: z.array(
    z.object({ keyId: installationKeyIdSchema, fingerprint: installationKeyFingerprintSchema }),
  ),
});
export type ImportRecoveryKitResponse = z.infer<typeof importRecoveryKitResponseSchema>;

/**
 * Removing an imported key. The confirmation is the key's own label, typed.
 *
 * Not a constant phrase: a constant proves the operator can read, while the
 * label proves they are looking at the row they mean to remove.
 */
export const removeInstallationKeyRequestSchema = z
  .object({
    keyId: installationKeyIdSchema,
    confirmation: z.string().max(128),
    idempotencyKey: z.string().min(8).max(255),
  })
  .strict();
export type RemoveInstallationKeyRequest = z.infer<typeof removeInstallationKeyRequestSchema>;

export const removeInstallationKeyResponseSchema = z.object({
  keyId: installationKeyIdSchema,
  removed: z.literal(true),
});
export type RemoveInstallationKeyResponse = z.infer<typeof removeInstallationKeyResponseSchema>;

export const RECOVERY_KIT_ROUTES = {
  keys: '/recovery-kit/keys',
  export: '/recovery-kit/export',
  import: '/recovery-kit/import',
  remove: '/recovery-kit/keys/remove',
} as const;
