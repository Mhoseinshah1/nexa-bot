import { z } from 'zod';

/**
 * Backup — the installation's disaster-recovery artifact and its delivery.
 *
 * A backup is one artifact and four claims about it: that the dump completed,
 * that the bytes are the bytes we produced, that they can be decrypted, and
 * that PostgreSQL can actually restore them. A pipeline that stops after the
 * first claim has produced a file, not a backup — which is what the legacy
 * system had. Its "backup" was a database dump piped into a ZIP and posted into
 * a chat: unencrypted, never restored, never checked, with the archive's own
 * password sent through the same channel as the archive.
 *
 * So this contract is deliberately not one status enum with a `SUCCESS` member.
 * It separates the RUN — did the pipeline complete — from the DELIVERY, whose
 * third state is the one the legacy system could not express and the reason a
 * durable state model exists at all: we asked Telegram to accept a document and
 * never learned whether it did.
 *
 * See docs/adr/0011-backup-delivery.md for the compensating controls this
 * design owes, and docs/adr/0024-backup-pipeline.md for the pipeline itself.
 */

/**
 * A backup run's lifecycle.
 *
 * `RUNNING` is a claim on the installation, not merely a progress note — one
 * backup runs at a time and the row IS the lock. A run that ends leaves either
 * `SUCCEEDED` or `FAILED`, and both are terminal: a run is never retried in
 * place, because a retry re-dumps a database that has moved on and would then
 * describe a different moment under the same identity.
 *
 * `SUCCEEDED` means every stage passed, verification included. It never means
 * "the dump worked". A run whose restore verification failed is `FAILED`, and
 * its artifact is deleted rather than delivered: an archive nobody can restore
 * is worse than no archive, because its existence is what stops somebody
 * looking for a real one.
 */
export const BACKUP_RUN_STATES = ['RUNNING', 'SUCCEEDED', 'FAILED'] as const;
export type BackupRunState = (typeof BACKUP_RUN_STATES)[number];

/**
 * The pipeline stages, in order. A failed run records the stage it died in.
 *
 * The order is the contract: a stage may only run after the one before it
 * passed, so `DELIVER` cannot be reached without `VERIFY_RESTORE` having
 * succeeded. That single rule is what keeps "a successful pg_dump" from being
 * mistaken for a successful backup.
 *
 *   `DUMP`            pg_dump custom format against the live database, read-only
 *   `CHECKSUM`        SHA-256 over the plaintext custom-format dump
 *   `ENCRYPT`         streaming AES-256-GCM into the versioned archive
 *   `VERIFY_RESTORE`  decrypt through the REAL restore path, then pg_restore
 *                     into a fresh scratch database, then a structural check
 *   `DELIVER`         the encrypted archive, as a Telegram document
 *   `CLEANUP`         plaintext intermediates removed and the scratch dropped
 */
export const BACKUP_STAGES = [
  'DUMP',
  'CHECKSUM',
  'ENCRYPT',
  'VERIFY_RESTORE',
  'DELIVER',
  'CLEANUP',
] as const;
export type BackupStage = (typeof BACKUP_STAGES)[number];

/**
 * What we know about the delivery — which is not always whether it happened.
 *
 * This is the state the rest of the codebase does not have. `DELIVERY_OUTCOMES`
 * in `notifications.ts` has `FAILED_RETRYABLE`, which encodes a DECISION ("try
 * again") rather than a FACT, and is right there because a notification carries
 * a dedupe key and a duplicate operational alert costs nothing. A duplicate
 * forty-megabyte encrypted database dump posted into an administrators' group
 * is not free, and a resend cannot be justified by an outcome nobody observed.
 *
 *   `NOT_ATTEMPTED`     the run never reached DELIVER, or delivery is not
 *                       configured. Distinguished from failure: an installation
 *                       with no destination has not failed to deliver.
 *   `SUCCEEDED`         Telegram answered `ok: true`. The document is there.
 *   `FAILED_DEFINITIVE` Telegram answered, and the answer was no. A resend of
 *                       THIS artifact would be refused the same way. The run is
 *                       still `SUCCEEDED` if the artifact verified, because the
 *                       artifact is sound and only its transport failed.
 *   `OUTCOME_UNKNOWN`   we sent bytes and never learned the verdict — a
 *                       timeout, a dropped socket, a 2xx we could not parse.
 *                       The document may be in the group. Nothing retries this
 *                       automatically. It is a durable record for a person or a
 *                       future reconciliation to resolve, and the one state
 *                       whose whole purpose is to refuse to guess.
 */
export const BACKUP_DELIVERY_STATES = [
  'NOT_ATTEMPTED',
  'SUCCEEDED',
  'FAILED_DEFINITIVE',
  'OUTCOME_UNKNOWN',
] as const;
export type BackupDeliveryState = (typeof BACKUP_DELIVERY_STATES)[number];

/**
 * Why a run started.
 *
 * Recorded, and deliberately NOT branched on anywhere in the pipeline. Manual
 * and scheduled runs take the same lock, the same stages and the same
 * verification; this field says who asked, not what happens. A second execution
 * path for "the operator pressed the button" is how a scheduled backup and a
 * manual one come to differ in exactly the property nobody tests.
 *
 * `PRE_RESTORE` is the mandatory backup a recovery takes of the installation it
 * is about to replace, and it is a third VALUE rather than a third code path
 * precisely because of the rule above. It goes through `BackupService.run`
 * unchanged: the same lock, the same six stages, the same mandatory
 * verification. What differs is only what the recovery executor then DEMANDS of
 * the result — `SUCCEEDED` with a non-null `verifiedAt`, or the recovery aborts
 * before anything destructive happens.
 *
 * Calling it `MANUAL` would have avoided a migration and put a false statement
 * in the one table an operator reads after a disaster: the row that says what
 * the installation looked like just before it was replaced is the row they need
 * to be able to find, and `trigger` is how they find it.
 */
export const BACKUP_TRIGGERS = ['MANUAL', 'SCHEDULED', 'PRE_RESTORE'] as const;
export type BackupTrigger = (typeof BACKUP_TRIGGERS)[number];

/**
 * The archive container's magic and version.
 *
 * A version in the FILE, not only in the manifest, because restore tooling must
 * be able to reject an archive it cannot read before it has decrypted anything
 * — and because the manifest travels inside the encrypted region, where a
 * restore tool cannot consult it first. Bumping this is a format change with a
 * reader for both versions, never a silent edit.
 */
export const BACKUP_ARCHIVE_MAGIC = 'NEXABAK1';
export const BACKUP_ARCHIVE_FORMAT_VERSION = 1;

/**
 * The checksum, and what it covers.
 *
 * SHA-256 over the PLAINTEXT custom-format dump, byte for byte, as pg_dump
 * wrote it. Stated precisely because "the checksum" is ambiguous by default and
 * the ambiguity decides what the check can detect.
 *
 * Over the plaintext, it answers the question a restore actually asks: are
 * these the bytes PostgreSQL produced? It therefore detects truncation,
 * modification and corruption anywhere in the chain INCLUDING the encrypt and
 * decrypt steps, and it stays verifiable years later by anyone holding the key
 * and the manifest.
 *
 * A checksum over the ciphertext would detect less: it says an archive is the
 * archive we wrote, and says nothing about whether decryption reproduced the
 * dump. AES-GCM's authentication tag already covers the ciphertext, so a
 * ciphertext digest would duplicate the tag and leave the plaintext unchecked.
 * Both protections exist here, and they answer different questions on purpose.
 */
export const BACKUP_CHECKSUM_ALGORITHM = 'sha256';

/**
 * Telegram's `sendDocument` ceiling for a bot, in bytes.
 *
 * Fifty mebibytes, and this is ADR-0011's third compensating control: above it
 * the artifact is retained on the host and the group receives a NOTIFICATION
 * naming the backup and where it is, rather than a truncated document or a
 * silent failure. An installation whose database has outgrown the channel must
 * hear that from the system, not discover it during a restore.
 */
export const BACKUP_TELEGRAM_DOCUMENT_MAX_BYTES = 50 * 1024 * 1024;

/**
 * How long a `RUNNING` row may go without progress before another process may
 * take the lock from it.
 *
 * A backup is long, so a lease rather than a lock held on a connection: a
 * transaction-scoped advisory lock cannot survive an installation's
 * `idle_in_transaction_session_timeout`, and a session-scoped one dies with a
 * pooled connection that gets recycled. The row's heartbeat is what proves the
 * owner is alive, and this is the ceiling on how stale that proof may be.
 */
export const BACKUP_LEASE_STALE_AFTER_MS = 15 * 60 * 1000;

/** How often a running backup refreshes its lease. Well inside the ceiling. */
export const BACKUP_LEASE_HEARTBEAT_MS = 60 * 1000;

/**
 * The manifest: what this archive is, travelling inside the encrypted region.
 *
 * Inside, because it names the database and the installation. It carries no
 * key, no key material, no wrapped key and no credential — the archive header
 * carries the wrapped data key, which is a different thing, and the KEK it is
 * wrapped under never leaves the host's configuration.
 *
 * `createdAt` is the moment the DUMP began, not the moment the archive was
 * written. A restore is being asked "what state of the world is this", and the
 * answer is the dump's start, not the end of a pipeline that ran for minutes
 * afterwards.
 */
export const backupManifestSchema = z.object({
  manifestVersion: z.literal(1),
  /** UUIDv7. The run's identity, and the delivery's stable identity. */
  backupId: z.string().min(1),
  /** Which installation produced this. Never a credential, never a host name. */
  installationId: z.string().min(1),
  createdAt: z.iso.datetime(),
  /** The database that was dumped, by name. Never a connection string. */
  databaseName: z.string().min(1),
  /** The server's `server_version`, so a restore can refuse a downgrade. */
  postgresVersion: z.string().min(1),
  /** `pg_dump`'s own version, which decides the custom format's dialect. */
  pgDumpVersion: z.string().min(1),
  dumpFormat: z.literal('custom'),
  /** Bytes of the PLAINTEXT dump. */
  dumpBytes: z.number().int().nonnegative(),
  checksumAlgorithm: z.literal(BACKUP_CHECKSUM_ALGORITHM),
  /** Lowercase hex, over the plaintext dump. See `BACKUP_CHECKSUM_ALGORITHM`. */
  checksum: z.string().regex(/^[0-9a-f]{64}$/),
  /**
   * What was deliberately left out, and why — one entry per exclusion.
   *
   * Empty in V1, and the emptiness is the point: nothing is excluded by naming
   * convention, by table prefix, or because a table "looks like a cache".
   * `processed_messages` looks transient and is the only thing standing between
   * a redelivered outbox message and a duplicated effect. Anything ever added
   * here needs a reason a restorer can evaluate, carried in the artifact itself.
   */
  exclusions: z.array(z.object({ object: z.string(), reason: z.string() })),
});
export type BackupManifest = z.infer<typeof backupManifestSchema>;

/**
 * The archive header: the cleartext preamble a restore tool reads first.
 *
 * Cleartext by necessity — it holds what is needed to begin decrypting — and
 * therefore bound as the AEAD associated data of the payload, so a header that
 * has been edited fails authentication rather than steering the decryption.
 *
 * `keyId` names the KEK the data key is wrapped under, matching the keyring
 * discipline the rest of the installation already uses: one key encrypts, every
 * held key may decrypt, so a rotation is an overlap rather than a flag day.
 */
export const backupArchiveHeaderSchema = z.object({
  format: z.literal(BACKUP_ARCHIVE_FORMAT_VERSION),
  backupId: z.string().min(1),
  /** Which KEK wraps the data key. Not the key. */
  keyId: z.string().min(1),
  /** base64url. The data key, wrapped under the KEK named by `keyId`. */
  wrapIv: z.string().min(1),
  wrappedKey: z.string().min(1),
  wrapTag: z.string().min(1),
  /** base64url. The payload's GCM nonce. */
  iv: z.string().min(1),
  cipher: z.literal('aes-256-gcm'),
});
export type BackupArchiveHeader = z.infer<typeof backupArchiveHeaderSchema>;
