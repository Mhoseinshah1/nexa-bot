import {
  RECOVERY_CANDIDATE_PREFIX,
  RECOVERY_DISPLACED_PREFIX,
  RECOVERY_LEASE_HEARTBEAT_MS,
  RECOVERY_LEASE_STALE_AFTER_MS,
  type Clock,
  type OperationalEventRecorder,
  type RecoveryFailureCode,
  type ScopeContext,
} from '@nexa/contracts';
import type { BackupService } from '../../backup/application/backup.service.js';
import type {
  CutoverJournal,
  RecoveryRequestRepository,
  RecoveryRequestRow,
  RecoveryWorkspaceFactory,
  RestoreEngine,
} from './ports.js';
import type { RecoveryService } from './recovery.service.js';

/**
 * The destructive half of a recovery, in its own process.
 *
 * A fourth process role rather than a loop in the worker, and that is not
 * tidiness. The worker runs the outbox relay and the notification dispatcher,
 * and this executor's job includes QUIESCING both of them: a loop that shares an
 * event loop with the things it is shutting down is a loop that has to reason
 * about its own shutdown, and the one place that reasoning has to be simple is
 * the place that renames the production database.
 *
 * ONE OWNER. The request's lease is taken by a conditional UPDATE
 * (`claimConfirmed`), and the database's partial unique index permits one
 * destructive recovery at a time. Two executor replicas is the normal case on
 * every rolling update; neither has to agree with the other about anything.
 *
 * THE ORDER IS THE CONTRACT, and every arrow before the cutover leaves
 * production exactly as it was — not because the error handling is careful, but
 * because nothing has written to production at all:
 *
 *   claim -> re-check the binding -> EMERGENCY BACKUP -> quiesce
 *         -> create candidate -> restore -> migrate if behind -> validate
 *         -> journal -> CUT OVER -> journal -> re-assert -> readiness -> done
 *
 * The emergency backup is MANDATORY and has no override. An operator who cannot
 * take a backup of their current database is an operator who must not replace it,
 * and there is deliberately no flag that says otherwise: ADR-0028 § 9, and
 * `docs/backup.md` says so where an operator will read it.
 */

export interface RecoveryExecutorDeps {
  readonly requests: RecoveryRequestRepository;
  readonly recovery: RecoveryService;
  readonly engine: RestoreEngine;
  readonly workspaces: RecoveryWorkspaceFactory;
  readonly journal: CutoverJournal;
  /** The unmodified Backup V1 pipeline. The emergency backup is a trigger value. */
  readonly backup: BackupService;
  /** Whether the installation can serve traffic, asked AFTER the cutover. */
  readonly readiness: () => Promise<{ degraded: boolean }>;
  readonly clock: Clock;
  readonly opsLog: OperationalEventRecorder;
  readonly scope: () => ScopeContext | null;
  readonly leaseOwner: string;
  readonly tickIntervalMs: number;
  readonly logger: {
    info(context: Record<string, unknown>, message: string): void;
    warn(context: Record<string, unknown>, message: string): void;
    error(context: Record<string, unknown>, message: string): void;
  };
}

/**
 * A failure that carries a SAFE code.
 *
 * Every abort path in this file throws one of these, so the code that reaches
 * the row and the operational event is always from the frozen vocabulary. An
 * ordinary `Error` escaping would land as `recovery.internal`, which is the
 * honest answer for something this file did not anticipate and the wrong answer
 * for everything it did.
 */
class RecoveryAbort extends Error {
  constructor(
    readonly code: RecoveryFailureCode,
    message: string,
  ) {
    super(message);
  }
}

export class RecoveryExecutor {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private lastTickAt: number | null = null;

  constructor(private readonly deps: RecoveryExecutorDeps) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.tick(), this.deps.tickIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Whether this loop is doing its job, for the process's health check.
   *
   * Progress-based, not existence-based, for the reason
   * `BackupScheduler.isFresh` is: a loop whose ticks are all throwing has a live
   * timer and is not working. Three intervals of slack, so one slow tick is not
   * an outage — and a tick here can legitimately take an hour, which is why the
   * heartbeat inside a run is what keeps the LEASE fresh while this only reports
   * that the loop is alive.
   */
  isFresh(nowMs: number): boolean {
    if (this.lastTickAt === null) return false;
    return nowMs - this.lastTickAt <= this.deps.tickIntervalMs * 3;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.reclaimAbandoned();

      // Our OWN in-flight request first. A process that restarted mid-recovery
      // must not wait fifteen minutes for its own lease to go stale — with the
      // installation quiesced, that is fifteen minutes of refused writes.
      const own = await this.deps.requests.claimOwn({
        leaseOwner: this.deps.leaseOwner,
        now: this.deps.clock.now(),
      });
      const claimed =
        own ??
        (await this.deps.requests.claimConfirmed({
          leaseOwner: this.deps.leaseOwner,
          now: this.deps.clock.now(),
        }));

      this.lastTickAt = this.deps.clock.now().getTime();
      if (claimed === null) return;
      await this.execute(claimed);
    } catch (error) {
      // Never fatal to the loop: a tick that throws must not end recoveries for
      // the life of the process. `lastTickAt` is deliberately NOT advanced here,
      // so a run of failing ticks makes the health check say so.
      this.deps.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'recovery executor tick failed',
      );
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Closes recoveries whose executor stopped reporting.
   *
   * FAILED, never adopted — the same rule an abandoned backup lease follows, and
   * here it matters more: the abandoned request may own a candidate database a
   * process is still restoring into, and a second restorer writing into it is how
   * two partial restores become one plausible-looking database.
   *
   * The candidate and the workspace are LEFT WHERE THEY ARE and named on the
   * event, because deleting another process's output is the other way to corrupt
   * it. An operator is told what to clean up.
   */
  private async reclaimAbandoned(): Promise<void> {
    const now = this.deps.clock.now();
    const reclaimed = await this.deps.requests.reclaimStale({
      staleBefore: new Date(now.getTime() - RECOVERY_LEASE_STALE_AFTER_MS),
      now,
    });
    for (const row of reclaimed) {
      this.deps.logger.error(
        {
          recoveryId: row.id,
          state: row.state,
          candidateDatabase: row.candidateDatabase,
          workspacePath: row.workspacePath,
        },
        'a recovery was abandoned by a process that stopped reporting and has been failed',
      );
      await this.report({
        code: 'recovery.run_failed',
        severity: 'CRITICAL',
        message:
          `Recovery ${row.id} was abandoned by a process that stopped reporting and has been ` +
          `closed as failed at ${row.state}.`,
        context: {
          recoveryId: row.id,
          state: row.state,
          candidateDatabase: row.candidateDatabase,
          workspacePath: row.workspacePath,
          displacedDatabase: row.displacedDatabase,
        },
        dedupeKey: `recovery.${row.id}`,
      });
    }
  }

  /** Runs one confirmed recovery, or fails it with a safe code. */
  async execute(request: RecoveryRequestRow): Promise<void> {
    const heartbeat = this.startHeartbeat(request.id);
    try {
      await this.runStages(request);
      await this.report({
        code: 'recovery.run_ok',
        severity: 'INFO',
        message: `Recovery ${request.id} completed, and the installation reports ready.`,
        context: { recoveryId: request.id, backupId: request.backupId },
        recoversCode: 'recovery.run_failed',
        recoversDedupeKey: `recovery.${request.id}`,
      });
    } catch (error) {
      const code = error instanceof RecoveryAbort ? error.code : 'recovery.internal';
      // The real reason goes to the LOG with the recovery id. The event and the
      // row get the code alone, because an operational event's `message` is
      // projected to the Telegram report group and is never redacted — the
      // channel Architecture Hardening finding 18 closed for the backup pipeline.
      this.deps.logger.error(
        {
          recoveryId: request.id,
          code,
          err: error instanceof Error ? error.message : String(error),
        },
        'recovery failed',
      );
      const current = await this.deps.requests.byIdUnscoped(request.id);
      if (current === null) {
        /*
         * The row is not in the database that is live now.
         *
         * Reachable only between the renames and the re-assert, which is the one
         * window where the row an operator would read is in a database that is no
         * longer addressed. Writing it here is what keeps a failure IN that window
         * from vanishing: the alternative is a renamed production database and no
         * record of why.
         *
         * The journal on disk is the other half of this, and it is what a restarted
         * executor reads — this covers the case where the process survives.
         */
        await this.deps.requests.reassert({
          ...request,
          state: 'FAILED',
          stage: 'CLEANUP',
          updatedAt: this.deps.clock.now(),
          finishedAt: this.deps.clock.now(),
          failureCode: code,
        });
      }
      await this.deps.requests.transition({
        id: request.id,
        from: [
          'RESTORE_REQUESTED',
          'PRE_RESTORE_BACKUP',
          'QUIESCING',
          'RESTORING',
          'VALIDATING',
          'CUTTING_OVER',
          'RESTARTING',
        ],
        to: 'FAILED',
        now: this.deps.clock.now(),
        leaseOwner: this.deps.leaseOwner,
        patch: { failureCode: code },
      });
      await this.report({
        code: 'recovery.run_failed',
        severity: 'CRITICAL',
        // Author-controlled. The stage and the code are closed vocabularies and
        // are what make the alert actionable; nothing interpolated here comes
        // from an exception.
        message: `Recovery ${request.id} failed at ${current?.stage ?? 'UNKNOWN'} (${code}).`,
        context: {
          recoveryId: request.id,
          code,
          // The one fact an operator needs most after a failed recovery: whether
          // production is the old database or the new one, and where the other
          // one is.
          cutoverDone: current?.cutoverAt !== null && current?.cutoverAt !== undefined,
          displacedDatabase: current?.displacedDatabase ?? null,
          candidateDatabase: current?.candidateDatabase ?? null,
        },
        dedupeKey: `recovery.${request.id}`,
      });
    } finally {
      heartbeat.stop();
    }
  }

  private async runStages(request: RecoveryRequestRow): Promise<void> {
    const id = request.id;

    // ---- RE-CHECK THE BINDING -------------------------------------------
    //
    // The confirmation was checked when it was accepted. It is checked AGAIN
    // here, against the row as it stands, because between the two there was a
    // process boundary and a claim: the executor must not take an operator's
    // word relayed through a row it has not inspected. A confirmation whose
    // checksum no longer matches the artifact is a confirmation for a different
    // artifact, which is the whole property the binding exists to provide.
    if (
      request.confirmedChecksum === null ||
      request.artifactChecksum === null ||
      request.confirmedChecksum !== request.artifactChecksum
    ) {
      throw new RecoveryAbort(
        'recovery.confirmation_invalid',
        'The confirmation on this request does not name its artifact.',
      );
    }
    if (request.restoreTest === null || !request.restoreTest.cutoverPermitted) {
      throw new RecoveryAbort(
        'recovery.confirmation_invalid',
        'This request has no passing restore test.',
      );
    }
    if (request.workspacePath === null) {
      throw new RecoveryAbort(
        'recovery.upload_rejected',
        'This request has no workspace to restore from.',
      );
    }

    // ---- EMERGENCY PRE-RESTORE BACKUP -----------------------------------
    //
    // Of the CURRENT installation, through the unmodified Backup V1 pipeline:
    // the same lock, the same six stages, the same mandatory verification. It
    // must reach SUCCEEDED with a non-null `verifiedAt`, and there is no
    // override — the thing most likely to be needed after restoring the wrong
    // artifact is the database that was there before.
    //
    // BEFORE the quiesce, deliberately: this stage writes to `backup_runs`, to
    // `operational_events` and to the outbox, and
    // `RECOVERY_QUIESCING_STATES` excludes `PRE_RESTORE_BACKUP` so that it can.
    await this.advance(id, ['RESTORE_REQUESTED'], 'PRE_RESTORE_BACKUP', 'EMERGENCY_BACKUP');
    const emergency = await this.deps.backup.run('PRE_RESTORE');
    if (emergency.kind === 'BUSY') {
      // A scheduled backup holds the lock. Not a failure of this design and not
      // something to wait out while holding a confirmation: the operator
      // retries, which costs them a minute and costs the installation nothing.
      throw new RecoveryAbort(
        'recovery.emergency_backup_busy',
        'A backup was already running, so the mandatory pre-restore backup could not start.',
      );
    }
    if (emergency.run.state !== 'SUCCEEDED' || emergency.run.verifiedAt === null) {
      throw new RecoveryAbort(
        'recovery.emergency_backup_failed',
        'The mandatory pre-restore backup did not produce a verified artifact.',
      );
    }
    await this.deps.requests.progress({
      id,
      stage: 'EMERGENCY_BACKUP',
      leaseOwner: this.deps.leaseOwner,
      now: this.deps.clock.now(),
      patch: { preRestoreBackupId: emergency.run.id },
    });

    // ---- QUIESCE ---------------------------------------------------------
    //
    // The transition itself IS the quiesce: `RECOVERY_QUIESCING_STATES` starts
    // here, and the write gate in the unit of work and the relay reads that
    // state. There is no second flag to set, which is why there is no window in
    // which one says stopped and the other says running.
    await this.advance(id, ['PRE_RESTORE_BACKUP'], 'QUIESCING', 'QUIESCE');
    const quiesced = await this.deps.requests.installationLock();
    if (quiesced === null || !quiesced.quiescing || quiesced.recoveryId !== id) {
      // The gate reads the same row this transition just wrote, so a lock that
      // does not report us is a lock we do not hold — and restoring a candidate
      // while writes are still landing would make the candidate stale before it
      // was finished. Asserted rather than assumed, because this is the one
      // stage whose failure is invisible in its own output.
      throw new RecoveryAbort(
        'recovery.quiesce_failed',
        'The installation did not report itself quiesced for this recovery.',
      );
    }

    // ---- RESTORE INTO A CANDIDATE ---------------------------------------
    //
    // Production is still serving reads throughout. A failure anywhere in here
    // costs a candidate database and nothing else.
    await this.advance(id, ['QUIESCING'], 'RESTORING', 'CREATE_CANDIDATE');
    const candidate = `${RECOVERY_CANDIDATE_PREFIX}${shortId(id)}`;
    await this.deps.requests.progress({
      id,
      stage: 'CREATE_CANDIDATE',
      leaseOwner: this.deps.leaseOwner,
      now: this.deps.clock.now(),
      // Recorded BEFORE it is created, so a crash between the two leaves a name
      // an operator can look for rather than an orphan nothing references.
      patch: { candidateDatabase: candidate },
    });
    try {
      await this.deps.engine.createDatabase(candidate);
    } catch (error) {
      throw new RecoveryAbort(
        'recovery.candidate_create_failed',
        `The candidate database could not be created: ${String(error)}`,
      );
    }

    const workspace = this.deps.workspaces.open(request.workspacePath);
    await this.deps.requests.progress({
      id,
      stage: 'RESTORE_CANDIDATE',
      leaseOwner: this.deps.leaseOwner,
      now: this.deps.clock.now(),
    });
    try {
      // The archive is decrypted again rather than reusing the verification's
      // plaintext: that file was removed as soon as the restore-test finished,
      // because a plaintext dump is the database with the encryption taken off
      // and leaving one on disk for the days a confirmation might take is the
      // thing the encryption was for.
      await this.deps.recovery.decryptForExecutor(id, workspace);
      await this.deps.engine.restoreIntoEmpty(candidate, workspace.dumpPath);
    } catch (error) {
      throw new RecoveryAbort(
        'recovery.candidate_restore_failed',
        `The candidate could not be restored: ${String(error)}`,
      );
    } finally {
      const left = await workspace.discardPlaintext();
      if (left.length > 0) {
        this.deps.logger.error(
          { recoveryId: id, leftovers: left },
          'a recovery left plaintext on disk after restoring its candidate',
        );
      }
    }

    // ---- VALIDATE --------------------------------------------------------
    //
    // A separate state from RESTORING because `pg_restore` exiting zero is not
    // the claim that a database is usable.
    await this.advance(id, ['RESTORING'], 'VALIDATING', 'VALIDATE_CANDIDATE');
    let inspection = await this.deps.engine.inspectDatabase(candidate);
    if (inspection.tableCount === 0) {
      throw new RecoveryAbort(
        'recovery.restored_database_empty',
        'The candidate restored and has no tables.',
      );
    }
    if (inspection.migrations === null) {
      throw new RecoveryAbort(
        'recovery.migration_state_unreadable',
        "The candidate's migration state could not be read.",
      );
    }
    let compatibility = this.deps.recovery.compatibility(inspection.migrations);
    if (!compatibility.permitted && compatibility.migratable) {
      // BEHIND, and this release's own migrations can move it forward. Against
      // the CANDIDATE only — `migrateCandidate` refuses the live database by
      // name — so a migration that fails costs a candidate and leaves production
      // untouched.
      await this.deps.requests.progress({
        id,
        stage: 'MIGRATE_CANDIDATE',
        leaseOwner: this.deps.leaseOwner,
        now: this.deps.clock.now(),
      });
      await this.deps.engine.migrateCandidate(candidate);
      inspection = await this.deps.engine.inspectDatabase(candidate);
      if (inspection.migrations === null) {
        throw new RecoveryAbort(
          'recovery.migration_state_unreadable',
          "The migrated candidate's migration state could not be read.",
        );
      }
      compatibility = this.deps.recovery.compatibility(inspection.migrations);
    }
    if (!compatibility.permitted) {
      // `none`, `diverged`, or a `behind` that would not migrate forward. Do not
      // guess and do not cut over: ADR-0028 § 7.
      throw new RecoveryAbort(
        'recovery.migration_incompatible',
        `The candidate's schema is ${compatibility.verdict} and cannot be cut over to.`,
      );
    }
    await this.deps.requests.progress({
      id,
      stage: 'VALIDATE_CANDIDATE',
      leaseOwner: this.deps.leaseOwner,
      now: this.deps.clock.now(),
      patch: {
        restoreTest: {
          restored: true,
          tableCount: inspection.tableCount,
          migrationVerdict: compatibility.verdict,
          appliedMigrations: compatibility.applied,
          expectedMigrations: compatibility.expected,
          cutoverPermitted: true,
        },
      },
    });

    // ---- CUT OVER --------------------------------------------------------
    await this.advance(id, ['VALIDATING'], 'CUTTING_OVER', 'CUTOVER');
    const displaced = `${RECOVERY_DISPLACED_PREFIX}${shortId(id)}`;
    const live = this.deps.engine.liveDatabase;

    // The journal, BEFORE the renames. `ALTER DATABASE` cannot run inside a
    // transaction, so the window between the two renames is real, and the row
    // that would record which side of it we are on lives inside the database
    // being renamed. ADR-0028 § 4: this file is the only thing on the host that
    // a database rename cannot move.
    await this.deps.journal.write({
      recoveryId: id,
      phase: 'ABOUT_TO_RENAME',
      liveDatabase: live,
      candidateDatabase: candidate,
      displacedDatabase: displaced,
      at: this.deps.clock.now(),
    });
    try {
      await this.deps.engine.cutover({ candidateName: candidate, displacedName: displaced });
    } catch (error) {
      throw new RecoveryAbort('recovery.cutover_failed', `The cutover failed: ${String(error)}`);
    }
    await this.deps.journal.write({
      recoveryId: id,
      phase: 'RENAMED',
      liveDatabase: live,
      candidateDatabase: candidate,
      displacedDatabase: displaced,
      at: this.deps.clock.now(),
    });

    // ---- RE-ASSERT, then READINESS ---------------------------------------
    //
    // Every statement from here lands in the RESTORED database, because the
    // connection string resolves to it now. The request's own row is therefore
    // the one that was in the BACKUP — which cannot contain this recovery, since
    // it had not happened when the backup was taken.
    //
    // So the row is WRITTEN rather than updated. ADR-0028 § 4 described this and
    // the first version of this file did not do it: the next transition was an
    // ordinary conditional UPDATE, it matched nothing in the restored database,
    // and three integration cases failed with an absent row. An ADR that
    // describes a step the code skips is worse than no ADR, because the next
    // reader believes the step is there.
    //
    // `byIdUnscoped` reads from the live handle too, so it is read BEFORE the
    // write from the in-memory row this method has been carrying — the database
    // it would read from no longer has it.
    const reasserted: RecoveryRequestRow = {
      ...request,
      state: 'RESTARTING',
      stage: 'READINESS',
      updatedAt: this.deps.clock.now(),
      leaseOwner: this.deps.leaseOwner,
      leaseHeartbeatAt: this.deps.clock.now(),
      preRestoreBackupId: emergency.run.id,
      candidateDatabase: candidate,
      displacedDatabase: displaced,
      cutoverAt: this.deps.clock.now(),
      finishedAt: null,
      failureCode: null,
    };
    await this.deps.requests.reassert(reasserted);

    // Readiness is the SAME computation the load balancer gets. A recovery is not
    // successful because `pg_restore` exited zero; it is successful when the
    // application can serve traffic against what it produced.
    const verdict = await this.deps.readiness();
    if (verdict.degraded) {
      throw new RecoveryAbort(
        'recovery.readiness_failed',
        'The installation did not become ready after the cutover.',
      );
    }

    const finished = await this.deps.requests.transition({
      id,
      from: ['RESTARTING'],
      to: 'SUCCEEDED',
      now: this.deps.clock.now(),
      leaseOwner: this.deps.leaseOwner,
      patch: { stage: 'DONE' },
    });
    if (!finished) {
      // The re-assert wrote RESTARTING with this lease, so this cannot fail for
      // an ordinary reason — and if it does, the recovery is NOT reported as a
      // success. A cutover that completed and could not be recorded is a database
      // an operator has to be told about.
      throw new RecoveryAbort(
        'recovery.internal',
        'The recovery completed and its final state could not be recorded.',
      );
    }
  }

  /**
   * One state transition, refused if the request is not where we left it.
   *
   * Guarded on the lease as well as the state, so a process whose lease was
   * reclaimed mid-recovery writes nothing: the row belongs to the takeover, and a
   * late transition from the abandoned process would carry it onwards past the
   * point somebody else has already failed it.
   */
  private async advance(
    id: string,
    from: readonly (
      | 'RESTORE_REQUESTED'
      | 'PRE_RESTORE_BACKUP'
      | 'QUIESCING'
      | 'RESTORING'
      | 'VALIDATING'
      | 'CUTTING_OVER'
    )[],
    to:
      | 'PRE_RESTORE_BACKUP'
      | 'QUIESCING'
      | 'RESTORING'
      | 'VALIDATING'
      | 'CUTTING_OVER'
      | 'RESTARTING',
    stage: Parameters<RecoveryRequestRepository['progress']>[0]['stage'],
    extra?: { cutoverAt?: Date; displacedDatabase?: string },
  ): Promise<void> {
    const moved = await this.deps.requests.transition({
      id,
      from: [...from],
      to,
      now: this.deps.clock.now(),
      leaseOwner: this.deps.leaseOwner,
      patch: {
        stage,
        ...(extra?.cutoverAt === undefined ? {} : { cutoverAt: extra.cutoverAt }),
        ...(extra?.displacedDatabase === undefined
          ? {}
          : { displacedDatabase: extra.displacedDatabase }),
      },
    });
    if (!moved) {
      throw new RecoveryAbort(
        'recovery.internal',
        `This recovery was no longer in ${from.join(' or ')} when the executor tried to advance it.`,
      );
    }
  }

  /**
   * Keeps the lease fresh while a long stage runs.
   *
   * Without it a restore that outlasts `RECOVERY_LEASE_STALE_AFTER_MS` would
   * have its own lease reclaimed underneath it — which, unlike a backup, would
   * leave the installation quiesced with nothing owning the recovery that
   * quiesced it.
   */
  private startHeartbeat(id: string): { stop(): void } {
    const timer = setInterval(() => {
      void this.deps.requests
        .heartbeat({ id, leaseOwner: this.deps.leaseOwner, now: this.deps.clock.now() })
        .catch((error: unknown) => {
          this.deps.logger.warn(
            { recoveryId: id, reason: error instanceof Error ? error.message : String(error) },
            'recovery lease heartbeat failed',
          );
        });
    }, RECOVERY_LEASE_HEARTBEAT_MS);
    timer.unref();
    return { stop: () => clearInterval(timer) };
  }

  /**
   * Records a recovery condition, if there is anybody to record it for.
   *
   * Never throws into the pipeline, for the reason `BackupService.report` does
   * not: a recovery that failed must report its real failure rather than a
   * secondary one from the reporting itself, which would replace the message an
   * operator needs with the message about why they did not get it.
   *
   * Deduped PER RECOVERY rather than installation-wide, unlike backups. Two
   * recoveries are two operations against two different artifacts, and
   * collapsing them onto one condition would hide the second.
   */
  private async report(event: {
    code: string;
    severity: 'INFO' | 'ERROR' | 'CRITICAL';
    message: string;
    context: Record<string, unknown>;
    dedupeKey?: string;
    recoversCode?: string;
    recoversDedupeKey?: string;
  }): Promise<void> {
    const scope = this.deps.scope();
    if (scope === null) {
      this.deps.logger.warn(
        { code: event.code },
        'no installation tenant is provisioned, so this recovery condition was not recorded',
      );
      return;
    }
    try {
      await this.deps.opsLog.record(scope, event);
    } catch (error) {
      this.deps.logger.error(
        { code: event.code, reason: error instanceof Error ? error.message : String(error) },
        'failed to record a recovery operational event',
      );
    }
  }
}

/**
 * A short, stable suffix for the two database names a recovery creates.
 *
 * Derived from the recovery id rather than random, so the candidate and the
 * displaced database are both attributable to the row that made them — which is
 * what an operator needs when a failure leaves one behind. Hyphens removed
 * because a PostgreSQL identifier built from them would need quoting everywhere
 * and `quoteIdent` refuses anything that is not a plain identifier.
 */
function shortId(recoveryId: string): string {
  return recoveryId.replace(/-/g, '').slice(0, 20);
}
