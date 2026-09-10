import {
  BACKUP_LEASE_HEARTBEAT_MS,
  BACKUP_LEASE_STALE_AFTER_MS,
  BACKUP_TELEGRAM_DOCUMENT_MAX_BYTES,
  NexaError,
  PLATFORM_ERROR_CODES,
  type BackupDeliveryState,
  type BackupManifest,
  type BackupStage,
  type BackupTrigger,
} from '@nexa/contracts';
import type { Clock, IdGenerator, OperationalEventRecorder, ScopeContext } from '@nexa/contracts';
import type {
  BackupArchiver,
  BackupDelivery,
  BackupRunRepository,
  BackupRunRow,
  BackupWorkspace,
  BackupWorkspaceFactory,
  DatabaseTools,
} from './ports.js';

/**
 * The backup pipeline.
 *
 * Six stages in a fixed order, and one rule that gives the order its meaning:
 * DELIVER is reachable only from a VERIFY_RESTORE that passed. Everything else
 * in this file is bookkeeping around that rule.
 *
 *   DUMP           pg_dump custom format, whole database, read-only
 *   CHECKSUM       SHA-256 over the plaintext dump
 *   ENCRYPT        streamed into the versioned authenticated archive
 *   VERIFY_RESTORE decrypt through the REAL restore path, pg_restore into a
 *                  freshly created EMPTY scratch database, structural check,
 *                  drop
 *   DELIVER        the encrypted archive as a Telegram document
 *   CLEANUP        plaintext gone, scratch gone, and said so if not
 *
 * A failure before DELIVER fails the RUN. A failure AT delivery does not: an
 * archive that dumped, checksummed, encrypted and restored is a sound backup
 * whose transport failed, and calling that a failed backup would tell an
 * operator their data is unprotected when it is sitting verified on their own
 * disk. The two facts are separate columns because they are separate facts.
 *
 * ONE EXECUTION PATH. `run()` is what the scheduler calls and what the operator
 * calls; `trigger` is recorded and never branched on. A second path for "the
 * operator pressed the button" is how the manual and scheduled backups come to
 * differ in exactly the property nobody tests — which, on a pipeline whose
 * whole purpose is the unattended case, would mean the tested path is the one
 * that does not matter.
 */

export interface BackupServiceDeps {
  readonly runs: BackupRunRepository;
  readonly tools: DatabaseTools;
  readonly archiver: BackupArchiver;
  readonly workspaces: BackupWorkspaceFactory;
  readonly delivery: BackupDelivery;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * Which installation produced the archive, for the manifest.
   *
   * A function, not a value: the primary tenant is resolved AFTER the container
   * is built, so a value captured at construction would be the placeholder for
   * the life of the process. Returns the literal `unprovisioned` when there is
   * no tenant yet — which is truthful, and is a state a backup can legitimately
   * be taken in.
   */
  readonly installationId: () => string;
  readonly logger: {
    info(context: Record<string, unknown>, message: string): void;
    warn(context: Record<string, unknown>, message: string): void;
    error(context: Record<string, unknown>, message: string): void;
  };
  /** This process's identity, so two replicas hold distinguishable leases. */
  readonly leaseOwner: string;
  /**
   * Where a failed run is reported, and who it is reported to.
   *
   * Backup V1 shipped without this, and the consequence was the worst shape a
   * gap in this feature can take: a failed SCHEDULED backup produced a log line
   * and a row, and nothing else. No operational event, so no notification —
   * silent on the channel this installation built to report failures, for the
   * one subsystem that runs entirely unattended. An operator would learn their
   * backups had stopped by looking, and the whole point of a backup is that
   * nobody looks until it is too late to start.
   *
   * The scope is a function because the installation's tenant is resolved after
   * the container is built. `null` means no tenant is provisioned yet, and a run
   * in that state records nothing rather than inventing an addressee — a
   * genuinely possible state, since a backup can be taken before provisioning.
   */
  readonly opsLog: OperationalEventRecorder;
  readonly scope: () => ScopeContext | null;
  /**
   * Where the archive stays when it is too large to send.
   *
   * Named in the notification rather than logged, so an operator reading the
   * group knows where to look. It is a path on their own server, not a secret.
   */
  readonly retainedArchiveHint: string;
}

/**
 * One key for the installation's backup condition.
 *
 * Not per-run: a run id would make every nightly failure a NEW condition, so an
 * operator would get an alert a night and an unresolved list that only grows —
 * the exact behaviour the legacy log group had, where 60 identical errors in a
 * day were 60 rows. One key means one open condition with an occurrence count,
 * and one recovery when it is fixed.
 */
const BACKUP_CONDITION_KEY = 'backup.run';

export type BackupOutcome =
  | { readonly kind: 'BUSY'; readonly holder: BackupRunRow }
  | { readonly kind: 'COMPLETED'; readonly run: BackupRunRow };

export class BackupService {
  constructor(private readonly deps: BackupServiceDeps) {}

  /**
   * Runs one backup, end to end, or reports truthfully that one is running.
   *
   * `BUSY` is a return value and not an exception because it is not a failure:
   * the installation's invariant is one backup at a time, and a second caller
   * being told "already running, since 09:14" is the invariant working.
   */
  async run(trigger: BackupTrigger): Promise<BackupOutcome> {
    // Release any lock whose owner died before it could. Done first, and by
    // FAILING the abandoned run rather than adopting it: its files belong to a
    // process that may still be writing them.
    const now0 = this.deps.clock.now();
    const reclaimed = await this.deps.runs.reclaimStale({
      staleBefore: new Date(now0.getTime() - BACKUP_LEASE_STALE_AFTER_MS),
      now: now0,
    });
    if (reclaimed > 0) {
      this.deps.logger.warn(
        { reclaimed },
        'closed a backup run whose lease had gone stale; its process is gone',
      );
      /*
       * REPORTED, not only logged. Review finding 3.
       *
       * A reclaim means a backup was under way and its process died — the worker
       * was SIGKILLed mid-dump, the container was evicted, the host rebooted. The
       * row is marked FAILED here, and before this the only trace was a log line:
       * no condition, no notification. Worse than silent, because the NEXT run
       * succeeds and reports `backup.run_ok`, which closes a condition that was
       * never opened — so an installation that lost a backup ends up looking
       * exactly like one that did not.
       *
       * Under the same installation-wide dedupe key as any other failure, so a
       * crash loop is one rising condition rather than an alert per tick, and a
       * later success closes it.
       */
      await this.report({
        code: 'backup.run_failed',
        severity: 'ERROR',
        message:
          `${String(reclaimed)} backup run(s) were abandoned by a process that stopped ` +
          'reporting, and have been closed as failed. Those backups did not complete.',
        context: { reclaimed },
        dedupeKey: BACKUP_CONDITION_KEY,
      });
    }

    const id = this.deps.ids.uuid();
    const startedAt = this.deps.clock.now();
    const claim = await this.deps.runs.start({
      id,
      trigger,
      leaseOwner: this.deps.leaseOwner,
      now: startedAt,
    });
    if (!claim.claimed) {
      return { kind: 'BUSY', holder: claim.holder };
    }

    const heartbeat = this.startHeartbeat(id);

    let stage: BackupStage = 'DUMP';
    /*
     * Created INSIDE the recorded region, because creating it can fail.
     *
     * It used to be the statement above the `try`, after the RUNNING row had been
     * claimed — so a work directory that could not be created threw straight out
     * of `run()` and left the claim behind. For a disaster-recovery pipeline that
     * is the worst available shape: no FAILED row, so no `backup.run_failed`
     * condition and no notification, while the RUNNING row holds the
     * installation's one-backup-at-a-time lease until it goes stale. Every later
     * backup is then refused as BUSY or spends its first act reclaiming a lease,
     * and the only symptom is the absence of backups — which looks exactly like
     * nothing being wrong.
     *
     * The triggers are not exotic: `BACKUP_WORK_DIR` on a full disk, a path that
     * is not a directory, a volume that did not mount. ADR-0025 notes that this
     * directory holds three artifacts at once, so it is the first thing to run out
     * of room.
     *
     * `workspace` is therefore `null` until it exists, and the `catch` has to
     * cope with that: there is nothing to discard when the failure IS that there
     * is nowhere to discard from.
     */
    let workspace: BackupWorkspace | null = null;
    let dumpBytes: bigint | null = null;
    let archiveBytes: bigint | null = null;
    let checksum: string | null = null;
    let verifiedAt: Date | null = null;
    let deliveryState: BackupDeliveryState = 'NOT_ATTEMPTED';
    let deliveryAttemptedAt: Date | null = null;
    let deliveryDetail: string | null = null;

    try {
      // ---- DUMP ------------------------------------------------------------
      await this.deps.runs.progress({
        id,
        stage: 'DUMP',
        leaseOwner: this.deps.leaseOwner,
        now: this.deps.clock.now(),
      });
      workspace = await this.deps.workspaces.create(id);
      const dump = await this.deps.tools.dump(workspace.dumpPath);

      // ---- CHECKSUM --------------------------------------------------------
      stage = 'CHECKSUM';
      await this.deps.runs.progress({
        id,
        stage,
        leaseOwner: this.deps.leaseOwner,
        now: this.deps.clock.now(),
      });
      const digest = await this.deps.archiver.checksum(workspace.dumpPath);
      checksum = digest.checksum;
      dumpBytes = BigInt(digest.bytes);
      if (digest.bytes === 0) {
        // pg_dump can exit zero having written nothing if its output was
        // redirected somewhere unwritable in an unusual way. An empty dump
        // restores perfectly and contains nothing, which is the single most
        // dangerous shape a "successful" backup can have.
        throw new NexaError({
          kind: 'INTERNAL',
          code: PLATFORM_ERROR_CODES.BACKUP_VERIFICATION_FAILED,
          message: 'The dump is empty. A zero-byte archive restores cleanly and holds nothing.',
        });
      }

      const manifest: BackupManifest = {
        manifestVersion: 1,
        backupId: id,
        installationId: this.deps.installationId(),
        // The moment the DUMP began, not the moment the archive finished: a
        // restore is being asked what state of the world this is.
        createdAt: startedAt.toISOString(),
        databaseName: dump.databaseName,
        postgresVersion: await this.deps.tools.serverVersion(),
        pgDumpVersion: dump.pgDumpVersion,
        dumpFormat: 'custom',
        dumpBytes: digest.bytes,
        checksumAlgorithm: 'sha256',
        checksum: digest.checksum,
        // Nothing is excluded. See `pg-tools.ts`: no table is left out by name,
        // by prefix or because it looks transient.
        exclusions: [],
      };

      // ---- ENCRYPT ---------------------------------------------------------
      stage = 'ENCRYPT';
      await this.deps.runs.progress({
        id,
        stage,
        leaseOwner: this.deps.leaseOwner,
        now: this.deps.clock.now(),
      });
      const sealed = await this.deps.archiver.seal({
        dumpPath: workspace.dumpPath,
        archivePath: workspace.archivePath,
        manifest,
      });
      archiveBytes = BigInt(sealed.archiveBytes);

      // ---- VERIFY_RESTORE --------------------------------------------------
      //
      // Through the real restore path, from the ENCRYPTED archive. Verifying
      // the plaintext dump we still have on disk would prove pg_dump works and
      // nothing about whether the artifact we are about to deliver can be
      // turned back into a database.
      stage = 'VERIFY_RESTORE';
      await this.deps.runs.progress({
        id,
        stage,
        leaseOwner: this.deps.leaseOwner,
        now: this.deps.clock.now(),
      });
      const verified = await this.verify(workspace, checksum, digest.bytes);
      verifiedAt = this.deps.clock.now();
      this.deps.logger.info(
        { backupId: id, tables: verified.tableCount },
        'backup archive restored into a scratch database and checked',
      );

      // The plaintext dump has done its work: it has been checksummed,
      // encrypted, and proven restorable through the encrypted path. It is the
      // one artifact here that is the database with the encryption taken off,
      // so it goes now rather than at the end.
      const plaintextLeft = await workspace.discardPlaintext();

      // ---- DELIVER ---------------------------------------------------------
      stage = 'DELIVER';
      await this.deps.runs.progress({
        id,
        stage,
        leaseOwner: this.deps.leaseOwner,
        now: this.deps.clock.now(),
      });
      const delivered = await this.deliver({
        id,
        manifest,
        archivePath: workspace.archivePath,
        archiveBytes: sealed.archiveBytes,
        tableCount: verified.tableCount,
      });
      deliveryState = delivered.state;
      deliveryDetail = delivered.detail;
      deliveryAttemptedAt = delivered.attemptedAt;

      // ---- CLEANUP ---------------------------------------------------------
      stage = 'CLEANUP';
      const leftovers = [...plaintextLeft, ...this.deps.tools.leaked];
      const cleanupOk = leftovers.length === 0;
      if (!cleanupOk) {
        this.deps.logger.error(
          { backupId: id, leftovers },
          'backup cleanup did not complete; artifacts remain on this host',
        );
      }

      // A success CLOSES an open failure. Recorded before the row is finished so
      // that a crash between the two leaves the condition open rather than
      // resolved — an operator chasing a backup that is fine costs an hour, and
      // one who believes a broken backup recovered costs a database.
      await this.report({
        code: 'backup.run_ok',
        severity: 'INFO',
        message: `Backup ${id} completed and was verified against a real restore.`,
        context: { backupId: id, trigger, delivery: deliveryState },
        recoversCode: 'backup.run_failed',
        recoversDedupeKey: BACKUP_CONDITION_KEY,
      });

      // Inside the `try`, so a rejection here is caught below and re-finished as
      // FAILED with a condition — the row does not stay RUNNING holding the
      // installation's lease. Worth stating because the review of this branch
      // suspected otherwise, and because the pool-error listener added here changes
      // what a connection death at this point looks like: the process used to die
      // and an orchestrator made that visible, and now it survives, so the recorded
      // failure is the only thing that will say anything.
      await this.deps.runs.finish({
        id,
        leaseOwner: this.deps.leaseOwner,
        state: 'SUCCEEDED',
        stage: 'CLEANUP',
        now: this.deps.clock.now(),
        dumpBytes,
        archiveBytes,
        checksum,
        verifiedAt,
        deliveryState,
        deliveryAttemptedAt,
        deliveryDetail,
        cleanupOk,
        cleanupDetail: cleanupOk ? null : leftovers.join(', '),
      });
    } catch (error) {
      const failureCode = error instanceof NexaError ? error.code : 'backup.failed';
      const failureMessage = error instanceof Error ? error.message : String(error);
      this.deps.logger.error({ backupId: id, stage, failureCode }, 'backup run failed');

      // The operator has to hear about this, and a log line is not hearing.
      // Deduped on one installation-wide key so a nightly failure is ONE open
      // condition with a rising occurrence count rather than a new alert every
      // night — which is the legacy log group's defect, and the reason the
      // recorder has a dedupe key at all.
      await this.report({
        code: 'backup.run_failed',
        severity: 'ERROR',
        message: `Backup ${id} failed at ${stage}: ${failureMessage}`,
        context: { backupId: id, trigger, stage, failureCode },
        dedupeKey: BACKUP_CONDITION_KEY,
      });

      // Everything goes, archive included. An archive from a run that failed
      // before verification is unproven, and an unproven archive on disk is
      // the thing that stops somebody looking for a real one.
      // `workspace` is null when the failure was the workspace itself. The
      // subprocess leak list is still read: a dump cannot have run without a
      // workspace, but reading it unconditionally means this line does not become
      // wrong the day something before the workspace spawns one.
      const leftovers = [
        ...(workspace === null ? [] : await workspace.discardAll()),
        ...this.deps.tools.leaked,
      ];
      await this.deps.runs.finish({
        id,
        leaseOwner: this.deps.leaseOwner,
        state: 'FAILED',
        stage,
        now: this.deps.clock.now(),
        dumpBytes,
        archiveBytes,
        checksum,
        verifiedAt,
        deliveryState,
        deliveryAttemptedAt,
        deliveryDetail,
        failureCode,
        failureMessage,
        cleanupOk: leftovers.length === 0,
        cleanupDetail: leftovers.length === 0 ? null : leftovers.join(', '),
      });
    } finally {
      heartbeat.stop();
    }

    const run = await this.deps.runs.byId(id);
    if (run === null) {
      throw new NexaError({
        kind: 'INTERNAL',
        code: PLATFORM_ERROR_CODES.BACKUP_RUN_MISSING,
        message: 'A backup run finished and its row could not be read back.',
      });
    }
    return { kind: 'COMPLETED', run };
  }

  /**
   * Decrypts the archive through the real restore path and restores it.
   *
   * Three separate things have to hold, and each catches a different failure:
   *
   *   - the archive authenticates and decrypts (a wrong key, a modified byte,
   *     a truncated file);
   *   - the decrypted bytes checksum to what the manifest says (any corruption
   *     the AEAD tag could not have covered — a bug on our side of it, and the
   *     property that stays checkable years from now);
   *   - PostgreSQL restores it into an empty database and something arrives (a
   *     dump that is well-formed and useless).
   */
  private async verify(
    workspace: BackupWorkspace,
    expectedChecksum: string,
    expectedBytes: number,
  ): Promise<{ tableCount: number }> {
    const opened = await this.deps.archiver.open({
      archivePath: workspace.archivePath,
      dumpPath: workspace.verifyDumpPath,
    });

    if (opened.dumpChecksum !== expectedChecksum || opened.dumpBytes !== expectedBytes) {
      throw new NexaError({
        kind: 'INTERNAL',
        code: PLATFORM_ERROR_CODES.BACKUP_CHECKSUM_MISMATCH,
        message:
          'The archive decrypted, and the bytes that came out are not the bytes that went in.',
        details: {
          expectedBytes,
          actualBytes: opened.dumpBytes,
        },
      });
    }
    if (opened.manifest.checksum !== expectedChecksum) {
      throw new NexaError({
        kind: 'INTERNAL',
        code: PLATFORM_ERROR_CODES.BACKUP_CHECKSUM_MISMATCH,
        message: 'The manifest inside the archive does not describe the dump beside it.',
      });
    }

    const outcome = await this.deps.tools.verifyRestore(workspace.verifyDumpPath);
    if (!outcome.ok) {
      throw new NexaError({
        kind: 'INTERNAL',
        code: PLATFORM_ERROR_CODES.BACKUP_VERIFICATION_FAILED,
        message: 'pg_restore could not restore this archive into an empty database.',
        details: { detail: outcome.detail },
      });
    }
    if (outcome.tableCount === 0) {
      throw new NexaError({
        kind: 'INTERNAL',
        code: PLATFORM_ERROR_CODES.BACKUP_VERIFICATION_FAILED,
        message:
          'The restore succeeded and produced no tables. An empty dump restores perfectly; ' +
          'that is the failure this check exists for.',
      });
    }
    return { tableCount: outcome.tableCount };
  }

  /**
   * Delivers the archive, and records what we actually learned.
   *
   * Above Telegram's document ceiling the group gets a MESSAGE naming the
   * backup and where it stays — ADR-0011's third compensating control. That is
   * a successful delivery of the thing that could be delivered, not a failure:
   * the artifact is on the operator's disk, verified, and they have been told.
   *
   * Nothing here retries. An `OUTCOME_UNKNOWN` is recorded and left alone,
   * because a blind resend of a document Telegram may already hold is a second
   * copy of an encrypted database in a chat, decided by a process that admits
   * it does not know.
   */
  private async deliver(input: {
    id: string;
    manifest: BackupManifest;
    archivePath: string;
    archiveBytes: number;
    tableCount: number;
  }): Promise<{
    state: BackupDeliveryState;
    detail: string | null;
    attemptedAt: Date | null;
  }> {
    if (!this.deps.delivery.configured) {
      return {
        state: 'NOT_ATTEMPTED',
        detail: 'No backup destination is configured.',
        attemptedAt: null,
      };
    }

    const attemptedAt = this.deps.clock.now();
    const caption = this.caption(input);

    if (input.archiveBytes > BACKUP_TELEGRAM_DOCUMENT_MAX_BYTES) {
      const attempt = await this.deps.delivery.sendMessage(
        `${caption}\n\nRETAINED: ${this.deps.retainedArchiveHint}\n` +
          'The archive is larger than Telegram accepts from a bot, so it stays on the server.',
      );
      return { state: attempt.state, detail: attempt.detail, attemptedAt };
    }

    const attempt = await this.deps.delivery.sendDocument({
      archivePath: input.archivePath,
      filename: `nexa-backup-${input.id}.nxb`,
      caption,
    });
    return { state: attempt.state, detail: attempt.detail, attemptedAt };
  }

  /**
   * What the group is told about a backup.
   *
   * Identity, time, size, the checksum that makes the artifact verifiable, and
   * the verification result. No token, no connection string, no database URL,
   * no key id — the key id names a KEK an operator holds and would be a hint
   * nobody needs in a chat, and the checksum is a digest, which is not one.
   */
  private caption(input: {
    id: string;
    manifest: BackupManifest;
    archiveBytes: number;
    tableCount: number;
  }): string {
    return [
      'NEXA BACKUP',
      `Backup: ${input.id}`,
      `Taken: ${input.manifest.createdAt}`,
      `Database: ${input.manifest.databaseName} (PostgreSQL ${input.manifest.postgresVersion})`,
      `Dump: ${input.manifest.dumpBytes} bytes`,
      `Archive: ${input.archiveBytes} bytes`,
      `SHA-256: ${input.manifest.checksum}`,
      `Verified: restored into an empty database, ${input.tableCount} tables`,
    ].join('\n');
  }

  /**
   * Records a backup condition, if there is anybody to record it for.
   *
   * Never throws into the pipeline. A run that succeeded and could not be
   * announced is still a run that succeeded, and a run that failed must report
   * its real failure rather than a secondary one from the reporting itself —
   * which would replace the message an operator needs with the message about
   * why they did not get it.
   */
  private async report(event: {
    code: string;
    severity: 'INFO' | 'ERROR';
    message: string;
    context: Record<string, unknown>;
    dedupeKey?: string;
    recoversCode?: string;
    recoversDedupeKey?: string;
  }): Promise<void> {
    const scope = this.deps.scope();
    if (scope === null) {
      // No tenant provisioned yet. Recording under an invented scope would be
      // worse than not recording: it would address the alert to nobody.
      this.deps.logger.warn(
        { code: event.code },
        'no installation tenant is provisioned, so this backup condition was not recorded',
      );
      return;
    }
    try {
      await this.deps.opsLog.record(scope, event);
    } catch (error) {
      this.deps.logger.error(
        { code: event.code, reason: error instanceof Error ? error.message : String(error) },
        'failed to record a backup operational event',
      );
    }
  }

  /**
   * Keeps the lease fresh while a long stage runs.
   *
   * Without it a dump that outlasts `BACKUP_LEASE_STALE_AFTER_MS` would have
   * its own lock reclaimed underneath it by the next scheduler tick — which is
   * the failure mode a lease introduces and the heartbeat removes.
   */
  private startHeartbeat(id: string): { stop(): void } {
    const timer = setInterval(() => {
      void this.deps.runs
        .heartbeat({ id, leaseOwner: this.deps.leaseOwner, now: this.deps.clock.now() })
        .catch((error: unknown) => {
          // Not fatal to the run: the work is still progressing, and a lost
          // heartbeat costs the lock, not the dump. Loud, because a run whose
          // lock is reclaimed while it is still writing is worth knowing about.
          this.deps.logger.warn(
            { backupId: id, reason: error instanceof Error ? error.message : String(error) },
            'backup lease heartbeat failed',
          );
        });
    }, BACKUP_LEASE_HEARTBEAT_MS);
    timer.unref();
    return {
      stop: () => clearInterval(timer),
    };
  }
}
