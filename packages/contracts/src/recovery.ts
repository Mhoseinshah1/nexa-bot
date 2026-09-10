import { z } from 'zod';
import type { StateMachineDefinition } from './state-machine.js';

/**
 * Recovery — restoring this installation from one of its own backups.
 *
 * Backup V1 answers "can this artifact become a database". Recovery answers the
 * question after it: "can this installation BE that database again". The two are
 * separate entities on purpose, and `docs/disaster-recovery-audit.md` § MISSING-2
 * records why a recovery must not be a row on `backup_runs` — a backup run is an
 * artifact's history, a recovery request is an operation against the
 * installation, and `backup_runs_single_active_idx` is a lock a recovery row
 * would contend with for no reason.
 *
 * The shape of this contract is driven by one property: **the production
 * database changes only after a restored candidate has been fully validated.**
 * Everything that looks like ceremony below — a confirmation bound to a
 * checksum, a mandatory pre-restore backup, a separate VALIDATING state after
 * RESTORING, a readiness check after CUTTING_OVER — exists because each is a
 * place where a restore that went wrong could otherwise have become production.
 *
 * See docs/adr/0028-web-disaster-recovery.md.
 */

/**
 * The states a recovery request passes through.
 *
 * Two chains meet here, and the order is the contract.
 *
 * The first is about the ARTIFACT, and it is reachable by an operator holding
 * nothing more dangerous than `recovery.restore`'s read half: an archive is
 * uploaded, decrypted and checksummed, then restored for real into a throwaway
 * database to prove PostgreSQL accepts it. Nothing about the installation has
 * changed at any point in that chain, and a request may sit in
 * `RESTORE_TEST_PASSED` for ever without consequence.
 *
 * The second is about the INSTALLATION, and nothing enters it without a typed
 * confirmation bound to that exact artifact. `RESTORE_REQUESTED` is the first
 * state that implies an intention to replace production, and
 * `PRE_RESTORE_BACKUP` is the first state that does any work towards it —
 * which is a backup, because the thing most likely to be needed after a
 * restore of the wrong artifact is the database that was there before.
 *
 *   `UPLOADED`            bytes are on disk in a private workspace. Nothing is
 *                         known about them; the filename and the declared type
 *                         are not evidence.
 *   `VERIFYING`           the container is being parsed, decrypted through
 *                         `openArchive`, and checksummed against its manifest.
 *   `VERIFIED`            it is a Nexa archive this installation can decrypt,
 *                         and its bytes are the bytes its manifest describes.
 *                         NOT "restorable" — that is the next state's claim.
 *   `RESTORE_TESTING`     a real `pg_restore` into a randomly named, freshly
 *                         created, EMPTY database.
 *   `RESTORE_TEST_PASSED` that restore succeeded, the database is not empty,
 *                         and its migration state is readable and compatible.
 *                         This is the only state from which a restore may be
 *                         requested, and reaching it has changed nothing.
 *   `RESTORE_REQUESTED`   an administrator holding a CRITICAL permission typed
 *                         the confirmation phrase, and the confirmation is bound
 *                         to this request, this artifact's checksum, that actor's
 *                         session, and an expiry.
 *   `PRE_RESTORE_BACKUP`  a full backup of the CURRENT installation is running,
 *                         through the unmodified Backup V1 pipeline, and must
 *                         reach SUCCEEDED with a verification before anything
 *                         else happens.
 *   `QUIESCING`           new durable writes are being refused installation-wide.
 *   `RESTORING`           the candidate database is being created and restored
 *                         into. Production is still serving.
 *   `VALIDATING`          the candidate is inspected: not empty, expected
 *                         objects present, migration state compatible. A
 *                         separate state from RESTORING because `pg_restore`
 *                         exiting zero is not the same claim.
 *   `CUTTING_OVER`        the two renames. The only irreversible moment, and it
 *                         is metadata-only.
 *   `RESTARTING`          processes are reconnecting and readiness is being
 *                         re-established against the restored database.
 *   `SUCCEEDED`           readiness came back READY. Not "pg_restore exited 0".
 *   `FAILED`              terminal, with a safe failure code. Production is the
 *                         database it was before, unless `cutoverAt` is set — in
 *                         which case the restored candidate is production and the
 *                         outgoing database is still on the server under the name
 *                         recorded on the row.
 */
export const RECOVERY_STATES = [
  'UPLOADED',
  'VERIFYING',
  'VERIFIED',
  'RESTORE_TESTING',
  'RESTORE_TEST_PASSED',
  'RESTORE_REQUESTED',
  'PRE_RESTORE_BACKUP',
  'QUIESCING',
  'RESTORING',
  'VALIDATING',
  'CUTTING_OVER',
  'RESTARTING',
  'SUCCEEDED',
  'FAILED',
] as const;
export type RecoveryState = (typeof RECOVERY_STATES)[number];

/** The two terminal states. Neither is ever left; a retry is a NEW request. */
export const RECOVERY_TERMINAL_STATES = ['SUCCEEDED', 'FAILED'] as const;

/**
 * The states during which the installation refuses new durable writes.
 *
 * Derived from the request's own state rather than held in a second flag,
 * because a second flag is a thing that can disagree with the first — and the
 * one it would disagree with is the one that decides whether a database is
 * about to be renamed. `docs/disaster-recovery-audit.md` § D-8.
 *
 * `PRE_RESTORE_BACKUP` is deliberately NOT in this list. That stage takes a
 * backup of the live installation, which is a write — to `backup_runs`, to
 * `operational_events`, to the outbox — and an installation that refused writes
 * during it could not take the backup that makes the rest of the operation
 * recoverable.
 */
export const RECOVERY_QUIESCING_STATES = [
  'QUIESCING',
  'RESTORING',
  'VALIDATING',
  'CUTTING_OVER',
  'RESTARTING',
] as const;
export type RecoveryQuiescingState = (typeof RECOVERY_QUIESCING_STATES)[number];

export function quiescesInstallation(state: RecoveryState): boolean {
  return (RECOVERY_QUIESCING_STATES as readonly string[]).includes(state);
}

/**
 * Whether this state means a destructive recovery is under way.
 *
 * Wider than `quiescesInstallation` by one state: `PRE_RESTORE_BACKUP` is
 * already past the confirmation, so a SECOND recovery request must not be
 * allowed to start — even though writes are still permitted. One destructive
 * recovery at a time is enforced by a partial unique index over exactly these
 * states.
 */
export const RECOVERY_ACTIVE_DESTRUCTIVE_STATES = [
  'RESTORE_REQUESTED',
  'PRE_RESTORE_BACKUP',
  ...RECOVERY_QUIESCING_STATES,
] as const;

export function isDestructiveRecoveryState(state: RecoveryState): boolean {
  return (RECOVERY_ACTIVE_DESTRUCTIVE_STATES as readonly string[]).includes(state);
}

/**
 * The stage in flight, reported to an operator watching a page.
 *
 * Separate from the state, and not a duplicate of it. A state is what the
 * request IS and what may happen to it next; a stage is what a process is
 * DOING, which is the thing an operator staring at a progress line wants. They
 * move together for most of the machine and diverge in `RESTORING`, where one
 * state covers creating a database and filling it.
 */
export const RECOVERY_STAGES = [
  'RECEIVE_UPLOAD',
  'PARSE_CONTAINER',
  'DECRYPT',
  'CHECKSUM',
  'MANIFEST',
  'SCRATCH_RESTORE',
  'SCRATCH_INSPECT',
  'AWAIT_CONFIRMATION',
  'EMERGENCY_BACKUP',
  'QUIESCE',
  'CREATE_CANDIDATE',
  'RESTORE_CANDIDATE',
  'MIGRATE_CANDIDATE',
  'VALIDATE_CANDIDATE',
  'CUTOVER',
  'READINESS',
  'CLEANUP',
  'DONE',
] as const;
export type RecoveryStage = (typeof RECOVERY_STAGES)[number];

/**
 * The events that drive the machine. One per transition reason.
 *
 * Named for what HAPPENED, not for what to do next: `VERIFY_FAILED` rather
 * than `FAIL`, because the machine is declared as data below and a single
 * `FAIL` event from every state would make the declaration unable to say which
 * failures are reachable from where.
 */
export const RECOVERY_EVENTS = [
  'VERIFY_START',
  'VERIFY_OK',
  'VERIFY_FAILED',
  'TEST_START',
  'TEST_OK',
  'TEST_FAILED',
  'CONFIRM',
  'BACKUP_START',
  'BACKUP_OK',
  'BACKUP_FAILED',
  'QUIESCE_OK',
  'QUIESCE_FAILED',
  'RESTORE_OK',
  'RESTORE_FAILED',
  'VALIDATE_OK',
  'VALIDATE_FAILED',
  'CUTOVER_OK',
  'CUTOVER_FAILED',
  'READY',
  'NOT_READY',
  'ABANDONED',
] as const;
export type RecoveryEvent = (typeof RECOVERY_EVENTS)[number];

/**
 * The machine, declared as DATA.
 *
 * `packages/contracts/src/state-machine.ts` has shipped since Phase 0 with
 * `validateStateMachine`, `canTransition`, `nextState` and an empty
 * `STATE_MACHINES` whose comment says the business machines arrive with their
 * modules. This is the first one, and declaring it here is what makes "no
 * arbitrary state jumps" a checked property of a graph rather than the shape of
 * a switch statement somebody could extend without noticing.
 *
 * Two properties the validator proves and a reviewer would not: every state is
 * reachable from `UPLOADED`, and every non-terminal state has an outgoing
 * transition — so there is no state a recovery can enter and never leave, which
 * for an operation that quiesces the installation is the difference between a
 * bug and an outage.
 *
 * `ABANDONED` is the lease takeover: a recovery whose executor stopped
 * reporting is FAILED from wherever it was, never adopted, for the same reason
 * a stale backup lease is — its candidate database and its workspace belong to a
 * process that may still be writing them.
 */
export const RECOVERY_MACHINE: StateMachineDefinition<RecoveryState, RecoveryEvent> = {
  name: 'recovery',
  initial: 'UPLOADED',
  states: RECOVERY_STATES,
  terminal: RECOVERY_TERMINAL_STATES,
  transitions: [
    { from: 'UPLOADED', to: 'VERIFYING', on: 'VERIFY_START' },
    { from: 'UPLOADED', to: 'FAILED', on: 'ABANDONED' },
    { from: 'VERIFYING', to: 'VERIFIED', on: 'VERIFY_OK' },
    { from: 'VERIFYING', to: 'FAILED', on: 'VERIFY_FAILED' },
    { from: 'VERIFYING', to: 'FAILED', on: 'ABANDONED' },
    { from: 'VERIFIED', to: 'RESTORE_TESTING', on: 'TEST_START' },
    { from: 'VERIFIED', to: 'FAILED', on: 'ABANDONED' },
    { from: 'RESTORE_TESTING', to: 'RESTORE_TEST_PASSED', on: 'TEST_OK' },
    { from: 'RESTORE_TESTING', to: 'FAILED', on: 'TEST_FAILED' },
    { from: 'RESTORE_TESTING', to: 'FAILED', on: 'ABANDONED' },
    /*
     * The only door into the destructive chain, and the only transition whose
     * guard is a human action rather than a process outcome.
     *
     * The guard is named here and implemented in the module, which is what the
     * `guard` field is for: documentation in the contract, code beside the
     * transition that performs it.
     */
    {
      from: 'RESTORE_TEST_PASSED',
      to: 'RESTORE_REQUESTED',
      on: 'CONFIRM',
      guard: 'confirmationBoundToThisArtifactAndActorAndNotExpired',
    },
    { from: 'RESTORE_TEST_PASSED', to: 'FAILED', on: 'ABANDONED' },
    { from: 'RESTORE_REQUESTED', to: 'PRE_RESTORE_BACKUP', on: 'BACKUP_START' },
    { from: 'RESTORE_REQUESTED', to: 'FAILED', on: 'ABANDONED' },
    { from: 'PRE_RESTORE_BACKUP', to: 'QUIESCING', on: 'BACKUP_OK' },
    { from: 'PRE_RESTORE_BACKUP', to: 'FAILED', on: 'BACKUP_FAILED' },
    { from: 'PRE_RESTORE_BACKUP', to: 'FAILED', on: 'ABANDONED' },
    { from: 'QUIESCING', to: 'RESTORING', on: 'QUIESCE_OK' },
    { from: 'QUIESCING', to: 'FAILED', on: 'QUIESCE_FAILED' },
    { from: 'QUIESCING', to: 'FAILED', on: 'ABANDONED' },
    { from: 'RESTORING', to: 'VALIDATING', on: 'RESTORE_OK' },
    { from: 'RESTORING', to: 'FAILED', on: 'RESTORE_FAILED' },
    { from: 'RESTORING', to: 'FAILED', on: 'ABANDONED' },
    { from: 'VALIDATING', to: 'CUTTING_OVER', on: 'VALIDATE_OK' },
    { from: 'VALIDATING', to: 'FAILED', on: 'VALIDATE_FAILED' },
    { from: 'VALIDATING', to: 'FAILED', on: 'ABANDONED' },
    { from: 'CUTTING_OVER', to: 'RESTARTING', on: 'CUTOVER_OK' },
    { from: 'CUTTING_OVER', to: 'FAILED', on: 'CUTOVER_FAILED' },
    { from: 'CUTTING_OVER', to: 'FAILED', on: 'ABANDONED' },
    { from: 'RESTARTING', to: 'SUCCEEDED', on: 'READY' },
    { from: 'RESTARTING', to: 'FAILED', on: 'NOT_READY' },
    { from: 'RESTARTING', to: 'FAILED', on: 'ABANDONED' },
  ],
};

/**
 * The SAFE failure codes. A closed vocabulary, and that is the whole point.
 *
 * A recovery can fail with an arbitrary exception underneath it — a `pg_restore`
 * stderr, a filesystem error naming a path, a driver message naming a host and a
 * role. None of that may reach an operator channel: `docs/hardening-audit.md` § K
 * records that an operational event's `message` is projected to the Telegram
 * report group and is never redacted, and Architecture Hardening finding 18
 * closed that channel for the backup pipeline by keeping the uncontrolled string
 * out of `message`. This enum is the same discipline made total: the row, the
 * API response and the event all carry a code from this list, and the
 * uncontrolled text goes to the log with a correlation id.
 */
export const RECOVERY_FAILURE_CODES = [
  /** Upload exceeded the configured ceiling, or the stream ended early. */
  'recovery.upload_rejected',
  /** Not a Nexa archive, a future format, an implausible length. */
  'recovery.archive_malformed',
  /** Authenticated decryption failed. One code for all four causes. */
  'recovery.archive_auth_failed',
  /** The archive names a KEK this installation does not hold. See D-10. */
  'recovery.archive_foreign_key',
  /** The decrypted bytes are not the bytes the manifest describes. */
  'recovery.checksum_mismatch',
  /** The manifest does not parse, or does not describe the payload. */
  'recovery.manifest_invalid',
  /** `pg_restore` refused the artifact, or the scratch could not be made. */
  'recovery.restore_test_failed',
  /** The restore produced no tables. An empty dump restores perfectly. */
  'recovery.restored_database_empty',
  /** The candidate's migration state cannot be read. */
  'recovery.migration_state_unreadable',
  /** `none` or `diverged`, or `behind` that would not migrate forward. */
  'recovery.migration_incompatible',
  /** The confirmation is absent, expired, for another artifact, or replayed. */
  'recovery.confirmation_invalid',
  /** The mandatory pre-restore backup did not reach a verified success. */
  'recovery.emergency_backup_failed',
  /** A backup already held the installation's lock. Retry is a new request. */
  'recovery.emergency_backup_busy',
  /** Writes could not be stopped, so the candidate would be stale. */
  'recovery.quiesce_failed',
  /** The candidate database could not be created. */
  'recovery.candidate_create_failed',
  /** `pg_restore` into the candidate failed. Production is untouched. */
  'recovery.candidate_restore_failed',
  /** The candidate restored and did not pass validation. */
  'recovery.candidate_validation_failed',
  /** The rename failed. Which side it failed on is on the row. */
  'recovery.cutover_failed',
  /** The cutover completed and readiness did not come back READY. */
  'recovery.readiness_failed',
  /** The executor stopped reporting and its lease was taken over. */
  'recovery.lease_expired',
  /** Anything this vocabulary does not name. Logged in full, reported as this. */
  'recovery.internal',
] as const;
export type RecoveryFailureCode = (typeof RECOVERY_FAILURE_CODES)[number];

/**
 * Where the artifact being recovered came from.
 *
 * `LOCAL_RUN` is a backup this installation took and still holds on disk, picked
 * from the history. `UPLOAD` is bytes an operator sent, which is the case that
 * matters after a host has been rebuilt — and the case where nothing about the
 * file may be trusted.
 */
export const RECOVERY_SOURCES = ['UPLOAD', 'LOCAL_RUN'] as const;
export type RecoverySource = (typeof RECOVERY_SOURCES)[number];

/**
 * The exact phrase. Compared byte for byte after trimming, and nothing else.
 *
 * Not localised, and not case-insensitive. An operator about to replace their
 * production database types eleven ASCII characters; a phrase that accepted
 * near-misses would be a phrase that accepted a paste of the label next to the
 * box. It is in the contract rather than in the surface so the server is what
 * decides, and a second surface cannot invent a friendlier one.
 */
export const RECOVERY_CONFIRMATION_PHRASE = 'RESTORE NEXA';

/**
 * How long a confirmation stays usable.
 *
 * Short, because its whole purpose is to mean "the person who typed this is
 * still the person at the keyboard". Long enough that a slow pre-restore backup
 * does not invalidate the confirmation that started it — the expiry is checked
 * once, when the confirmation is accepted, and the executor re-checks the
 * BINDING rather than the clock.
 */
export const RECOVERY_CONFIRMATION_TTL_MS = 10 * 60 * 1000;

/** How long a recovery may go without progress before it may be taken over. */
export const RECOVERY_LEASE_STALE_AFTER_MS = 15 * 60 * 1000;
/** How often a running recovery refreshes its lease. Well inside the ceiling. */
export const RECOVERY_LEASE_HEARTBEAT_MS = 60 * 1000;

/**
 * The prefix every database this feature creates is named with.
 *
 * One prefix for candidates and one for the outgoing database a cutover
 * displaces, so debris is recognisable as debris and an operator reading
 * `\l` can tell which of the three databases in front of them is production.
 * Neither can collide with the live name, and `assertNotLiveTarget` says so
 * anyway.
 */
export const RECOVERY_CANDIDATE_PREFIX = 'nexa_candidate_';
export const RECOVERY_DISPLACED_PREFIX = 'nexa_pre_restore_';

/**
 * A recovery id, and the reason it is its own type.
 *
 * UUIDv7, like every other identity here. Named separately because it appears
 * in a confirmation binding, a URL, a journal file and an operational event
 * context, and a `string` in all four is how one of them ends up holding a
 * backup id.
 */
export const recoveryIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

/**
 * What is known about an uploaded artifact BEFORE it is trusted.
 *
 * Every field here is derived server-side. The filename a browser sent is
 * recorded as `clientFilename` and used for NOTHING — not for the path, not for
 * the format decision, not for the content type — because it is attacker-chosen
 * text. It exists so an operator can recognise which file they sent.
 */
export const uploadedArtifactSchema = z.object({
  /** Bytes actually received and written, counted by the server. */
  sizeBytes: z.number().int().nonnegative(),
  /** SHA-256 of the ENCRYPTED container as received. Detects a bad transfer. */
  archiveSha256: z.string().regex(/^[0-9a-f]{64}$/),
  /**
   * What the browser claimed, recorded and never acted on.
   *
   * Bounded and stripped of everything but a safe subset, because it is
   * rendered: a filename is a place to put markup, a path traversal and a
   * right-to-left override.
   */
  clientFilename: z.string().max(200),
});
export type UploadedArtifact = z.infer<typeof uploadedArtifactSchema>;

/**
 * What verification established. Facts, each separately checkable.
 *
 * `decrypted` and `checksumMatches` are two fields rather than one `valid`
 * because they fail for different reasons and an operator needs to know which:
 * a failed decrypt is a wrong installation or a corrupt file, while a
 * decrypt that succeeded with a checksum that did not is something wrong on our
 * side of the AEAD.
 */
export const recoveryVerificationSchema = z.object({
  formatVersion: z.number().int().positive(),
  backupId: z.string(),
  /** The KEK this archive names. An identifier, never key material. */
  keyId: z.string(),
  decrypted: z.boolean(),
  checksumMatches: z.boolean(),
  /** From the manifest: what database, what server, when, how big. */
  databaseName: z.string(),
  postgresVersion: z.string(),
  pgDumpVersion: z.string(),
  takenAt: z.iso.datetime(),
  dumpBytes: z.number().int().nonnegative(),
  checksum: z.string().regex(/^[0-9a-f]{64}$/),
  /** Asserted empty by a test. A non-empty list is a partial backup. */
  exclusions: z.array(z.object({ object: z.string(), reason: z.string() })),
});
export type RecoveryVerification = z.infer<typeof recoveryVerificationSchema>;

/**
 * The migration verdict for a restored candidate, as the API reports it.
 *
 * The same five words `MigrationVerdict` already uses, because they are the same
 * question asked of a different database — and because a second vocabulary for
 * "is this schema the one this code was built for" is how the two come to
 * disagree. `docs/disaster-recovery-audit.md` § D-7.
 */
export const RECOVERY_MIGRATION_VERDICTS = [
  'CURRENT',
  'AHEAD',
  'BEHIND',
  'NONE',
  'DIVERGED',
] as const;
export type RecoveryMigrationVerdict = (typeof RECOVERY_MIGRATION_VERDICTS)[number];

/**
 * Which verdicts this release will cut over to.
 *
 * `CURRENT` and `AHEAD`, matching `ReadinessService.checkSchema` exactly.
 * `BEHIND` is migrated forward against the CANDIDATE and must then be
 * `CURRENT`; it is not in this list because a behind candidate is not cut over
 * to as it stands.
 */
export const RECOVERY_CUTOVER_READY_VERDICTS = ['CURRENT', 'AHEAD'] as const;

export function cutoverPermitted(verdict: RecoveryMigrationVerdict): boolean {
  return (RECOVERY_CUTOVER_READY_VERDICTS as readonly string[]).includes(verdict);
}

/**
 * What a restore-test proved about the candidate.
 *
 * `tableCount` is here because zero is the failure this check exists for: an
 * empty dump restores perfectly and holds nothing, which is the most dangerous
 * shape a successful-looking backup can have.
 */
export const recoveryRestoreTestSchema = z.object({
  restored: z.boolean(),
  tableCount: z.number().int().nonnegative(),
  migrationVerdict: z.enum(RECOVERY_MIGRATION_VERDICTS),
  /** Applied migrations the candidate carries. A count, never their content. */
  appliedMigrations: z.number().int().nonnegative(),
  /** What this release expects, so the two numbers can be compared by eye. */
  expectedMigrations: z.number().int().nonnegative(),
  /** Whether this candidate could be cut over to as it stands. */
  cutoverPermitted: z.boolean(),
});
export type RecoveryRestoreTest = z.infer<typeof recoveryRestoreTestSchema>;

/**
 * The confirmation an operator types, and what it is bound to.
 *
 * The phrase alone is a constant and therefore proves nothing; the BINDING is
 * the security property. A confirmation is accepted only when the request is in
 * `RESTORE_TEST_PASSED`, the checksum the caller echoes is the checksum the
 * verification recorded, the actor is the one the session belongs to, and the
 * clock is inside the TTL. A confirmation for backup A cannot restore backup B,
 * and a replayed request finds the state already advanced.
 */
export const recoveryConfirmationSchema = z.object({
  phrase: z.string().max(64),
  /**
   * The artifact the operator believes they are restoring, echoed back.
   *
   * This is what makes the confirmation specific. Without it the confirmation
   * says "restore something", and a request that had been re-verified against a
   * different upload in between would consume it.
   */
  artifactChecksum: z.string().regex(/^[0-9a-f]{64}$/),
  /** The usual requirement on a state-changing command. */
  idempotencyKey: z.string().min(8).max(255),
});
export type RecoveryConfirmation = z.infer<typeof recoveryConfirmationSchema>;

/**
 * Whether a typed phrase is the confirmation phrase.
 *
 * A function rather than an inline `===` so the rule is callable by a test with
 * the near-misses that must NOT pass — a different case, a missing space, the
 * Persian label beside the box, a paste with a trailing newline. Trimming is
 * the one concession, because a trailing newline from a paste is not a different
 * intention.
 */
export function isRecoveryConfirmationPhrase(value: string): boolean {
  return value.trim() === RECOVERY_CONFIRMATION_PHRASE;
}
