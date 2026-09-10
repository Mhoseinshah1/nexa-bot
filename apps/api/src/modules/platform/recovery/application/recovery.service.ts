import { createHash } from 'node:crypto';
import {
  errors,
  isRecoveryConfirmationPhrase,
  NexaError,
  PLATFORM_ERROR_CODES,
  RECOVERY_CONFIRMATION_TTL_MS,
  cutoverPermitted,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type PermissionKey,
  type RecoveryFailureCode,
  type RecoveryMigrationVerdict,
  type RecoveryRestoreTest,
  type RecoveryVerification,
  type ScopeContext,
  type TenantContext,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../access/application/permission-guard.js';
import { recordMutationDenial } from '../../access/application/authorized-mutation.js';
import type { BackupArchiver } from '../../backup/application/ports.js';
import {
  compareMigrations,
  type ExpectedMigration,
} from '../../../../infrastructure/persistence/migration-state.js';
import type {
  CandidateCompatibility,
  RecoveryCursor,
  RecoveryRequestRepository,
  RecoveryRequestRow,
  RecoveryWorkspace,
  RecoveryWorkspaceFactory,
  RestoreEngine,
} from './ports.js';

/**
 * The operator's half of a recovery: everything that happens BEFORE the
 * installation is at risk.
 *
 * Upload, verify, restore-test and confirm. Every one of them is reachable with
 * `backup.view` except the last, and that split is deliberate:
 * `docs/disaster-recovery-audit.md` and the permission catalogue both say so.
 * Proving an archive is sound changes nothing about the installation, and an
 * operator who cannot check their backups without also holding the power to
 * overwrite production will not check them.
 *
 * The destructive half is `RecoveryExecutor`, in a different process. This
 * service never renames a database, never quiesces anything, and never touches
 * the live database beyond its own rows.
 *
 * SCOPE. A backup is a dump of the whole database, so there is one set of them
 * and the question is which tenant may act on it. The answer is the
 * installation's PRIMARY tenant, and a request from any other scope gets
 * not-found rather than permission-denied: a permission-denied for an id that
 * exists in another scope is itself a disclosure.
 */

export const BACKUP_VIEW: PermissionKey = 'backup.view';
export const RECOVERY_RESTORE: PermissionKey = 'recovery.restore';

export interface RecoveryServiceDeps {
  readonly requests: RecoveryRequestRepository;
  readonly workspaces: RecoveryWorkspaceFactory;
  readonly archiver: BackupArchiver;
  readonly engine: RestoreEngine;
  readonly guard: PermissionGuard;
  readonly audit: AuditWriter;
  readonly opsLog: { record(scope: ScopeContext, event: unknown): Promise<unknown> };
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * The migrations this release expects, read from its own journal.
   *
   * A function rather than a value because `expectedMigrations` reads the
   * filesystem, and a container that did it eagerly would fail to construct in
   * any process that has no migrations directory beside it.
   */
  readonly expected: () => readonly ExpectedMigration[];
  readonly logger: {
    info(context: Record<string, unknown>, message: string): void;
    warn(context: Record<string, unknown>, message: string): void;
    error(context: Record<string, unknown>, message: string): void;
  };
}

/** What a verification or a restore-test concluded, for the caller to report. */
export interface RecoveryStepOutcome {
  readonly request: RecoveryRequestRow;
  readonly failureCode: RecoveryFailureCode | null;
}

export class RecoveryService {
  constructor(private readonly deps: RecoveryServiceDeps) {}

  // --- Reads ---------------------------------------------------------------

  async list(
    scope: TenantContext,
    actor: ActorContext,
    input: { limit: number; cursor: RecoveryCursor | null },
  ): Promise<{ rows: readonly RecoveryRequestRow[]; nextCursor: string | null }> {
    await this.authorize(scope, actor, BACKUP_VIEW, {
      action: 'recovery.list',
      entityType: 'Recovery',
      entityId: null,
    });
    return this.deps.requests.page({
      tenantId: scope.tenantId,
      limit: input.limit,
      cursor: input.cursor,
    });
  }

  async get(scope: TenantContext, actor: ActorContext, id: string): Promise<RecoveryRequestRow> {
    await this.authorize(scope, actor, BACKUP_VIEW, {
      action: 'recovery.get',
      entityType: 'Recovery',
      entityId: id,
    });
    return this.require(scope, id);
  }

  // --- Upload --------------------------------------------------------------

  /**
   * Creates a request and a private workspace for bytes that have not arrived.
   *
   * Called BEFORE the stream is read, so the row exists to hold the path. A
   * workspace created with no row to name it is debris nothing can attribute,
   * which is the mirror image of the defect Architecture Hardening finding 3
   * fixed on the backup pipeline: a row with no workspace.
   */
  async beginUpload(
    scope: TenantContext,
    actor: ActorContext,
    input: { clientFilename: string },
  ): Promise<{ request: RecoveryRequestRow; workspace: RecoveryWorkspace }> {
    await this.authorize(scope, actor, BACKUP_VIEW, {
      action: 'recovery.upload',
      entityType: 'Recovery',
      entityId: null,
    });

    const id = this.deps.ids.uuid();
    const now = this.deps.clock.now();
    await this.deps.requests.create({
      id,
      tenantId: scope.tenantId,
      source: 'UPLOAD',
      stage: 'RECEIVE_UPLOAD',
      requestedByAdminId: actor.id,
      requestedByLabel: actor.label,
      correlationId: actor.correlationId,
      now,
    });
    const workspace = await this.deps.workspaces.create(id);
    await this.deps.requests.progressUnowned({
      id,
      stage: 'RECEIVE_UPLOAD',
      now,
      patch: {
        workspacePath: workspace.directory,
        clientFilename: sanitiseFilename(input.clientFilename),
      },
    });
    return { request: await this.require(scope, id), workspace };
  }

  /**
   * Records what actually arrived. Called after the stream has been written.
   *
   * The SERVER's count and the SERVER's digest, never the client's. A client
   * checksum would be a value the uploader chose, and comparing a file against a
   * digest its sender supplied proves only that the sender can compute sha256.
   */
  async completeUpload(
    scope: TenantContext,
    id: string,
    input: { sizeBytes: number; archiveSha256: string },
  ): Promise<void> {
    await this.deps.requests.progressUnowned({
      id,
      stage: 'PARSE_CONTAINER',
      now: this.deps.clock.now(),
      patch: { uploadBytes: BigInt(input.sizeBytes), uploadSha256: input.archiveSha256 },
    });
    await this.require(scope, id);
  }

  /** Abandons a request whose upload failed, and removes its workspace. */
  async failUpload(
    scope: TenantContext,
    id: string,
    failureCode: RecoveryFailureCode,
  ): Promise<void> {
    const request = await this.deps.requests.byId(scope.tenantId, id);
    if (request === null) return;
    await this.clearWorkspace(id, request.workspacePath);
    await this.deps.requests.transition({
      id,
      from: ['UPLOADED', 'VERIFYING'],
      to: 'FAILED',
      now: this.deps.clock.now(),
      patch: { stage: 'CLEANUP', failureCode, workspacePath: null },
    });
  }

  // --- Verify and restore-test ---------------------------------------------

  /**
   * Verifies an uploaded archive and then restore-tests it, in one call.
   *
   * One call because they are one question from an operator's point of view --
   * can this file become a database -- and because leaving a VERIFIED request
   * sitting for somebody to press a second button is how a half-checked archive
   * comes to be treated as a checked one. They remain two STATES, so the row
   * still says which half failed.
   *
   * Every failure here lands as a `RECOVERY_FAILURE_CODES` value on the row and
   * as ONE error code at the boundary. The uncontrolled text -- a `pg_restore`
   * stderr, a filesystem path, a driver message -- goes to the log with the
   * correlation id and never into the response or an operational event.
   */
  async verifyAndTest(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
  ): Promise<RecoveryStepOutcome> {
    await this.authorize(scope, actor, BACKUP_VIEW, {
      action: 'recovery.verify',
      entityType: 'Recovery',
      entityId: id,
    });
    const request = await this.require(scope, id);
    if (request.workspacePath === null) {
      throw this.refuse('recovery.upload_rejected', 'This recovery has no uploaded archive.');
    }

    const moved = await this.deps.requests.transition({
      id,
      from: ['UPLOADED'],
      to: 'VERIFYING',
      now: this.deps.clock.now(),
      patch: { stage: 'DECRYPT' },
    });
    if (!moved) {
      // Not an error the operator caused: a second press, or a request already
      // past this point. The current row is the honest answer.
      return { request: await this.require(scope, id), failureCode: null };
    }

    const workspace = this.deps.workspaces.open(request.workspacePath);
    const verified = await this.decryptAndCheck(scope, id, workspace);
    if (verified.failureCode !== null) return verified;
    return this.restoreTest(scope, id, workspace);
  }

  /** DECRYPT, CHECKSUM and MANIFEST, over the real restore path. */
  private async decryptAndCheck(
    scope: TenantContext,
    id: string,
    workspace: RecoveryWorkspace,
  ): Promise<RecoveryStepOutcome> {
    let verification: RecoveryVerification;
    try {
      // `openArchive`, through the archiver -- the SAME function the pipeline's
      // own verification and the operator's `backup restore` use. A second
      // decrypt path here would be a path nobody restores through.
      const opened = await this.deps.archiver.open({
        archivePath: workspace.archivePath,
        dumpPath: workspace.dumpPath,
      });
      const matches = opened.dumpChecksum === opened.manifest.checksum;
      verification = {
        formatVersion: 1,
        backupId: opened.manifest.backupId,
        // That it authenticated under a key this installation holds is the only
        // fact about the key worth reporting. The key ID itself is deliberately
        // NOT echoed: it names a KEK the operator holds, and a browser is not a
        // place where knowing it buys anything.
        keyId: 'held',
        decrypted: true,
        checksumMatches: matches,
        databaseName: opened.manifest.databaseName,
        postgresVersion: opened.manifest.postgresVersion,
        pgDumpVersion: opened.manifest.pgDumpVersion,
        takenAt: opened.manifest.createdAt,
        dumpBytes: opened.dumpBytes,
        checksum: opened.dumpChecksum,
        exclusions: opened.manifest.exclusions,
      };
      if (!matches) {
        return this.failStep(scope, id, workspace, 'recovery.checksum_mismatch', 'VERIFYING', {
          verification,
        });
      }
    } catch (error) {
      return this.failStep(scope, id, workspace, this.classifyOpenFailure(error, id), 'VERIFYING');
    }

    const now = this.deps.clock.now();
    await this.deps.requests.transition({
      id,
      from: ['VERIFYING'],
      to: 'VERIFIED',
      now,
      patch: {
        stage: 'SCRATCH_RESTORE',
        backupId: verification.backupId,
        artifactChecksum: verification.checksum,
        verification,
        verifiedAt: now,
      },
    });
    return { request: await this.require(scope, id), failureCode: null };
  }

  /**
   * A REAL `pg_restore` into a real, freshly created, empty database.
   *
   * Not a parse, not a header check, not a dry run. The database is randomly
   * named, created seconds earlier, and dropped in a `finally` whatever happens
   * -- and the live database is refused BY NAME inside the engine, which makes
   * that a property of the operation rather than of these call sites.
   */
  private async restoreTest(
    scope: TenantContext,
    id: string,
    workspace: RecoveryWorkspace,
  ): Promise<RecoveryStepOutcome> {
    await this.deps.requests.transition({
      id,
      from: ['VERIFIED'],
      to: 'RESTORE_TESTING',
      now: this.deps.clock.now(),
      patch: { stage: 'SCRATCH_RESTORE' },
    });

    const scratch = `nexa_rtest_${this.deps.ids.uuid().replace(/-/g, '').slice(0, 16)}`;
    let restoreTest: RecoveryRestoreTest | null = null;
    let failure: RecoveryFailureCode | null = null;
    try {
      await this.deps.engine.createDatabase(scratch);
      await this.deps.engine.restoreIntoEmpty(scratch, workspace.dumpPath);
      const inspection = await this.deps.engine.inspectDatabase(scratch);
      if (inspection.tableCount === 0) {
        // An empty dump restores perfectly and holds nothing. This is the single
        // most dangerous shape a successful-looking artifact can have.
        failure = 'recovery.restored_database_empty';
      } else if (inspection.migrations === null) {
        // Absent or unparsable, which is NOT "no migrations applied". The safe
        // reading of "we cannot tell" is to refuse.
        failure = 'recovery.migration_state_unreadable';
      } else {
        const compatibility = this.compatibility(inspection.migrations);
        restoreTest = {
          restored: true,
          tableCount: inspection.tableCount,
          migrationVerdict: compatibility.verdict,
          appliedMigrations: compatibility.applied,
          expectedMigrations: compatibility.expected,
          cutoverPermitted: compatibility.permitted || compatibility.migratable,
        };
        if (!restoreTest.cutoverPermitted) failure = 'recovery.migration_incompatible';
      }
    } catch (error) {
      this.deps.logger.error(
        { recoveryId: id, err: error instanceof Error ? error.message : String(error) },
        'a recovery restore-test failed',
      );
      failure = 'recovery.restore_test_failed';
    } finally {
      // The scratch goes whatever happened. `dropDatabase` records a failed drop
      // on the engine's leak list rather than throwing, so a cleanup failure
      // cannot mask the outcome of the test it was cleaning up after.
      await this.deps.engine.dropDatabase(scratch);
      // And the PLAINTEXT goes. It is the one artifact here that is a database
      // with the encryption taken off, and it has done its work.
      const left = await workspace.discardPlaintext();
      if (left.length > 0) {
        this.deps.logger.error(
          { recoveryId: id, leftovers: left },
          'a recovery left plaintext on disk',
        );
      }
    }

    if (failure !== null || restoreTest === null) {
      return this.failStep(
        scope,
        id,
        workspace,
        failure ?? 'recovery.internal',
        'RESTORE_TESTING',
        restoreTest === null ? undefined : { restoreTest },
      );
    }
    await this.deps.requests.transition({
      id,
      from: ['RESTORE_TESTING'],
      to: 'RESTORE_TEST_PASSED',
      now: this.deps.clock.now(),
      patch: { stage: 'AWAIT_CONFIRMATION', restoreTest },
    });
    return { request: await this.require(scope, id), failureCode: null };
  }

  // --- Confirmation --------------------------------------------------------

  /**
   * Accepts the typed confirmation, binding it to this artifact and this actor.
   *
   * The phrase is a constant, so what is stored is the BINDING: the request, the
   * artifact's checksum, the administrator, their session and an expiry. The
   * transition is a conditional UPDATE from `RESTORE_TEST_PASSED` alone, which is
   * what makes a replay a no-op rather than a second restore -- a repeated
   * request finds the state already advanced and its UPDATE matches nothing.
   *
   * Authorised on `recovery.restore`, which is CRITICAL. The confirmation is
   * required ON TOP of the permission, never instead of it: a typed phrase is a
   * defence against a misclick, not against an actor who should not be here.
   */
  async confirm(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    input: { phrase: string; artifactChecksum: string },
  ): Promise<RecoveryRequestRow> {
    await this.authorize(scope, actor, RECOVERY_RESTORE, {
      action: 'recovery.confirm',
      entityType: 'Recovery',
      entityId: id,
    });
    const request = await this.require(scope, id);

    if (!isRecoveryConfirmationPhrase(input.phrase)) {
      throw this.confirmationRefused('The confirmation phrase does not match.');
    }
    if (
      request.artifactChecksum === null ||
      !constantTimeEqual(request.artifactChecksum, input.artifactChecksum)
    ) {
      // THE BINDING. Without it a confirmation says "restore something", and a
      // request re-verified against a different upload in between would consume
      // it.
      throw this.confirmationRefused('The confirmation names a different artifact.');
    }
    if (request.restoreTest === null || !request.restoreTest.cutoverPermitted) {
      throw this.confirmationRefused('This artifact has not passed a restore test.');
    }

    const now = this.deps.clock.now();
    const moved = await this.deps.requests.transition({
      id,
      from: ['RESTORE_TEST_PASSED'],
      to: 'RESTORE_REQUESTED',
      now,
      patch: {
        stage: 'AWAIT_CONFIRMATION',
        confirmedAt: now,
        confirmedByAdminId: actor.id,
        confirmedSessionId: actor.sessionId ?? null,
        confirmedChecksum: request.artifactChecksum,
        confirmationExpiresAt: new Date(now.getTime() + RECOVERY_CONFIRMATION_TTL_MS),
      },
    });
    if (!moved) {
      // A replay, or somebody else confirming first. Both are the same answer,
      // and neither is a second restore.
      throw this.confirmationRefused(
        'This recovery is no longer awaiting confirmation. Nothing was started twice.',
      );
    }

    // The audit row for the most dangerous thing an administrator can do here,
    // with the ARTIFACT's identity in it and not only the request's: a row
    // saying "confirmed recovery X" would not say what was restored.
    await this.deps.audit.record(scope, actor, {
      action: 'recovery.confirmed',
      entityType: 'Recovery',
      entityId: id,
      before: { state: 'RESTORE_TEST_PASSED' },
      after: {
        state: 'RESTORE_REQUESTED',
        backupId: request.backupId,
        artifactChecksum: request.artifactChecksum,
      },
      reason: 'An administrator confirmed a full installation restore.',
      result: 'SUCCESS',
    });

    return this.require(scope, id);
  }

  /**
   * Decrypts the archive again, for the EXECUTOR, immediately before the real
   * restore.
   *
   * Again, and not reused, because the verification's plaintext was removed the
   * moment the restore-test finished. A plaintext dump is the database with the
   * encryption taken off, and a confirmation can legitimately sit for the length
   * of the TTL — keeping one on disk across that window is precisely what the
   * encryption exists to prevent.
   *
   * The SAME `openArchive` the verification used, so the bytes the executor
   * restores are produced by the path the verification proved. A second decrypt
   * route here would mean the thing that was checked and the thing that is
   * restored came out of different functions.
   *
   * On this service rather than in the executor so there is one archiver
   * dependency and one decrypt call site; the executor holds no keyring.
   */
  async decryptForExecutor(recoveryId: string, workspace: RecoveryWorkspace): Promise<void> {
    const opened = await this.deps.archiver.open({
      archivePath: workspace.archivePath,
      dumpPath: workspace.dumpPath,
    });
    if (opened.dumpChecksum !== opened.manifest.checksum) {
      // The archive verified minutes or hours ago and does not now. Something
      // changed the file on disk, which is the one case where continuing would
      // restore bytes nobody checked.
      this.deps.logger.error(
        { recoveryId },
        'a recovery archive stopped matching its manifest between verification and restore',
      );
      throw this.refuse(
        'recovery.checksum_mismatch',
        'The archive no longer matches its manifest.',
      );
    }
  }

  // --- Helpers -------------------------------------------------------------

  /**
   * The migration verdict for a candidate, and the policy applied to it.
   *
   * `compareMigrations` is the SAME function readiness uses, against a different
   * database, and `cutoverPermitted` is the same policy. ADR-0028 records why
   * that matters: a cutover rule that diverged from the readiness rule would
   * refuse a database the next readiness check would accept, which is how the
   * retention exclusion came to disagree with `lastSucceededAt`.
   */
  compatibility(applied: readonly { hash: string; createdAt: number }[]): CandidateCompatibility {
    const expected = this.deps.expected();
    const verdict = compareMigrations(applied, expected);
    const asContract: RecoveryMigrationVerdict =
      verdict.state === 'current'
        ? 'CURRENT'
        : verdict.state === 'ahead'
          ? 'AHEAD'
          : verdict.state === 'behind'
            ? 'BEHIND'
            : verdict.state === 'none'
              ? 'NONE'
              : 'DIVERGED';
    return {
      verdict: asContract,
      applied: applied.length,
      expected: expected.length,
      permitted: cutoverPermitted(asContract),
      // BEHIND is the one verdict a candidate can be MOVED out of, by running
      // this release's own migrations against it. Production is untouched
      // throughout, so a migration that fails costs a candidate and nothing else.
      migratable: asContract === 'BEHIND',
    };
  }

  private async require(scope: TenantContext, id: string): Promise<RecoveryRequestRow> {
    const row = await this.deps.requests.byId(scope.tenantId, id);
    if (row === null) {
      // NOT_FOUND, never PERMISSION_DENIED, for an id belonging to another
      // scope. The repository's predicate makes the two answers identical, which
      // is the point: a permission-denied would confirm the id exists somewhere.
      throw errors.notFound(PLATFORM_ERROR_CODES.RECOVERY_REFUSED, 'No such recovery request.');
    }
    return row;
  }

  /** Removes a workspace and says so loudly if it could not. */
  private async clearWorkspace(id: string, path: string | null): Promise<void> {
    if (path === null) return;
    const leftovers = await this.deps.workspaces.open(path).discard();
    if (leftovers.length > 0) {
      this.deps.logger.error({ recoveryId: id, leftovers }, 'a recovery left files behind');
    }
  }

  /** Records a failure on the row and returns it, with the workspace cleaned. */
  private async failStep(
    scope: TenantContext,
    id: string,
    workspace: RecoveryWorkspace,
    failureCode: RecoveryFailureCode,
    from: 'VERIFYING' | 'RESTORE_TESTING',
    patch?: { verification?: RecoveryVerification; restoreTest?: RecoveryRestoreTest },
  ): Promise<RecoveryStepOutcome> {
    await this.clearWorkspace(id, workspace.directory);
    await this.deps.requests.transition({
      id,
      from: [from],
      to: 'FAILED',
      now: this.deps.clock.now(),
      patch: {
        stage: 'CLEANUP',
        failureCode,
        // The workspace is gone, so its path must not stay on the row: a path
        // that no longer exists reads as debris somebody should go and find.
        workspacePath: null,
        ...(patch?.verification === undefined ? {} : { verification: patch.verification }),
        ...(patch?.restoreTest === undefined ? {} : { restoreTest: patch.restoreTest }),
      },
    });
    return { request: await this.require(scope, id), failureCode };
  }

  /**
   * Maps an archive failure to a safe code, and logs the real reason.
   *
   * The outcomes are deliberately distinguishable ON THE ROW and not at the HTTP
   * boundary: an operator reading their own recovery needs to know whether the
   * key was wrong or the file was, and a caller probing the endpoint must not be
   * able to learn the same thing one request at a time.
   */
  private classifyOpenFailure(error: unknown, recoveryId: string): RecoveryFailureCode {
    const code = error instanceof NexaError ? error.code : null;
    this.deps.logger.error(
      { recoveryId, code, err: error instanceof Error ? error.message : String(error) },
      'a recovery archive could not be opened',
    );
    if (code === PLATFORM_ERROR_CODES.SECRET_KEY_UNKNOWN) {
      // The archive names a KEK this installation does not hold, which is the
      // foreign-installation case. Refused by design, not unimplemented.
      return 'recovery.archive_foreign_key';
    }
    if (code === PLATFORM_ERROR_CODES.BACKUP_ARCHIVE_MALFORMED) return 'recovery.archive_malformed';
    if (code === PLATFORM_ERROR_CODES.BACKUP_ARCHIVE_AUTH_FAILED) {
      return 'recovery.archive_auth_failed';
    }
    if (code === PLATFORM_ERROR_CODES.BACKUP_CHECKSUM_MISMATCH) return 'recovery.checksum_mismatch';
    return 'recovery.internal';
  }

  private refuse(failureCode: RecoveryFailureCode, message: string): NexaError {
    return errors.validation(PLATFORM_ERROR_CODES.RECOVERY_REFUSED, message, { failureCode });
  }

  private confirmationRefused(message: string): NexaError {
    return errors.validation(PLATFORM_ERROR_CODES.RECOVERY_CONFIRMATION_INVALID, message);
  }

  /**
   * Authorises, and leaves the same trace an early refusal leaves everywhere
   * else in this codebase.
   *
   * `recordMutationDenial` is the shared recorder the control plane and panels
   * use: without it a denied call here would write no audit row at all, which is
   * the defect OQ-3D-03 records and the reason that function exists.
   */
  private async authorize(
    scope: ScopeContext,
    actor: ActorContext,
    permission: PermissionKey,
    denial: { action: string; entityType: string; entityId: string | null },
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, permission);
    } catch (denied) {
      await recordMutationDenial(
        { guard: this.deps.guard, audit: this.deps.audit, opsLog: this.deps.opsLog as never },
        scope,
        actor,
        permission,
        denial,
        denied,
      );
      throw denied;
    }
  }
}

/**
 * What a client called its file, reduced to something safe to STORE and RENDER.
 *
 * Not used as a path: nothing from the request reaches a path component, which
 * is a property of `DirectoryRecoveryWorkspace` rather than of this function. It
 * is still reduced, because this string is rendered in a browser, and a filename
 * is a place to put a path traversal that looks like one and a bidirectional
 * override that makes `exploit.js.nxb` read as `exploit.nxb.js`.
 *
 * Written as a CODE-POINT filter rather than as a regular-expression character
 * class on purpose. A class covering this set has to CONTAIN the characters, and
 * a source file containing U+202E is a source file whose own diff lies about
 * itself -- which is the class of trick this function exists to defuse. The
 * ranges are named in hex, where a reader can check them.
 */
export function sanitiseFilename(raw: string): string {
  let out = '';
  for (const character of raw.normalize('NFC')) {
    const code = character.codePointAt(0) ?? 0;
    // C0 controls and DEL, and the C1 block.
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;
    // LRM and RLM.
    if (code === 0x200e || code === 0x200f) continue;
    // The embedding and override block: LRE, RLE, PDF, LRO, RLO.
    if (code >= 0x202a && code <= 0x202e) continue;
    // The isolate block: LRI, RLI, FSI, PDI.
    if (code >= 0x2066 && code <= 0x2069) continue;
    // A separator would make this READ like a path even though it is never used
    // as one, and a reader seeing one would reasonably assume it was.
    out += character === '/' || character === '\\' ? '_' : character;
    if (out.length >= 200) break;
  }
  // Leading dots last, so nothing reconstructed out of replaced characters
  // survives as a dot segment.
  const trimmed = out.replace(/^\.+/, '').trim();
  return trimmed === '' ? 'upload.nxb' : trimmed;
}

/**
 * Compares two hex digests without leaking where they differ.
 *
 * The confirmation's artifact checksum is compared against a stored value, and
 * an early-exit `===` on a hex string is a timing oracle for it. The oracle is
 * weak -- the value is not a secret, it is on a row the same actor can read --
 * but doing the comparison properly costs nothing, and a reader should not have
 * to work out which of the two cases this is.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

/** The digest of the bytes as received, computed by the server. */
export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
