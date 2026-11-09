import {
  BACKUP_LEASE_HEARTBEAT_MS,
  BACKUP_LEASE_STALE_AFTER_MS,
  NexaError,
  PLATFORM_ERROR_CODES,
  TENANT_ARCHIVE_ERROR_CODES,
  type BackupDeliveryState,
  type BackupPhaseDurationsMs,
  type BackupStage,
  type BackupTrigger,
  type Clock,
  type HeavyJobKind,
  type IdGenerator,
  type TenantArchiveManifest,
  type TenantRestoreMode,
  type TenantRestoreStage,
  type TenantContext,
} from '@nexa/contracts';
import type { BackupRunRepository, BackupRunRow } from './ports.js';
import { storedFailureMessage } from './stored-failure.js';

/**
 * Phase 6B (ADR-0039 § 2, § 4, § 5): the TENANT archive pipeline and its restore.
 *
 * THE SAME SIX STAGES as the installation backup (ADR-0025), on the same `backup_runs` row
 * machinery (`archive_scope = 'TENANT'`), the same lease and the same single-active index —
 * not a second backup stack:
 *
 *   DUMP           the logical export of one hosted tenant (`tenant-archive-export.ts`)
 *   CHECKSUM       SHA-256 per part, and of the manifest that lists them
 *   ENCRYPT        7z with the hosted bot's backup password (the archiver's 7-Zip and its
 *                  memory-bounded levels), the archive key wrapped in keys.json
 *   VERIFY_RESTORE the ENCRYPTED archive opened by the reader every restore uses, restored into
 *                  an EMPTY scratch at the archive's head, compared byte for byte, secrets read
 *   DELIVER        reachable ONLY from a VERIFY_RESTORE that passed
 *   CLEANUP        plaintext gone, scratch gone, and said so if not
 *
 * A run that fails before DELIVER deletes its archive: an unproven archive on disk is the
 * thing that stops somebody looking for a real one. Every run takes a heavy-job ticket of an
 * EXCLUSIVE kind first, so no two heavy jobs ever run at once.
 *
 * Delivery itself (the hosted bot's own operations group, never the owner's backup topic) is
 * Phase 6B PR-2; until then a verified archive stays on this server (`NOT_ATTEMPTED`).
 */

/** The workspace of one run: the plaintext parts, the verification copy, the archive. */
export interface TenantArchiveWorkspace {
  readonly plainDirectory: string;
  readonly verifyDirectory: string;
  readonly archivePath: string;
  /** Removes the plaintext parts and the verification copy. Returns what survived. */
  discardPlaintext(): Promise<readonly string[]>;
  /** Removes everything, archive included. Returns what survived. */
  discardAll(): Promise<readonly string[]>;
}

export interface TenantArchiveEngine {
  workspace(tenantId: string, runId: string): Promise<TenantArchiveWorkspace>;
  /** DUMP: the parts, the manifest and keys.json (the archive key wrapped by `password`). */
  dump(input: {
    readonly tenantId: string;
    readonly directory: string;
    readonly archiveId: string;
    readonly createdAt: Date;
    readonly password: string;
  }): Promise<{
    readonly manifest: TenantArchiveManifest;
    readonly manifestSha256: string;
    readonly dataBytes: number;
  }>;
  /** ENCRYPT: the 7z of the directory. */
  seal(input: {
    readonly directory: string;
    readonly archivePath: string;
    readonly password: string;
  }): Promise<{ readonly archiveBytes: number }>;
  /** VERIFY_RESTORE: open, scratch at the archive's head, load, compare, read secrets, drop. */
  verify(input: {
    readonly archivePath: string;
    readonly password: string;
    readonly directory: string;
    readonly expectedManifestSha256: string;
  }): Promise<{ readonly tables: number; readonly rows: number }>;
  /** Scratch databases a drop could not remove. */
  readonly leaked: readonly string[];
  /**
   * Drops the tenant scratch databases a KILLED run or restore left on the verify server
   * (security review of PR #447, finding 2). Called only inside an admitted EXCLUSIVE heavy
   * job, when no other archive or restore can own one; a database with a session is kept.
   */
  sweepAbandonedScratch(): Promise<ScratchSweep>;
}

/** What a scratch sweep dropped, and what it found and could not drop. */
export interface ScratchSweep {
  readonly dropped: readonly string[];
  readonly survived: readonly string[];
}

/** The heavy-job queue (`HeavyJobGate`), as this service uses it. */
export interface HeavyJobRunner {
  runWhenAdmitted<T>(
    kind: HeavyJobKind,
    tenantId: string,
    job: () => Promise<T>,
    options: {
      readonly pollMs: number;
      readonly maxWaitMs: number;
      readonly sleep: (ms: number) => Promise<void>;
    },
  ): Promise<{ readonly ran: true; readonly result: T } | { readonly ran: false }>;
}

/**
 * Phase 6B PR-2 (ADR-0039 § 7): where a VERIFIED hosted archive goes besides this server —
 * the hosted bot's OWN operations group's backups topic, by its own bot, if it connected one.
 * Never the owner's group, never the owner's `BACKUP_TELEGRAM_*` fallback chat. Reached only
 * from a VERIFY_RESTORE that passed.
 */
export interface HostedArchiveDelivery {
  deliver(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly archivePath: string;
    readonly archiveBytes: number;
    readonly checksum: string;
    readonly at: Date;
  }): Promise<{
    readonly state: BackupDeliveryState;
    readonly detail: string | null;
    readonly attemptedAt: Date | null;
  }>;
}

export interface TenantArchiveServiceDeps {
  readonly runs: BackupRunRepository;
  /** Absent: kept on this server, `NOT_ATTEMPTED` (PR-1's behaviour). */
  readonly delivery?: HostedArchiveDelivery;
  readonly engine: TenantArchiveEngine;
  readonly heavyJobs: HeavyJobRunner;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly leaseOwner: string;
  readonly queue: {
    readonly pollMs: number;
    readonly maxWaitMs: number;
    readonly sleep: (ms: number) => Promise<void>;
  };
  readonly logger: {
    info(context: Record<string, unknown>, message: string): void;
    error(context: Record<string, unknown>, message: string): void;
  };
}

export type TenantArchiveOutcome =
  | { readonly kind: 'COMPLETED'; readonly run: BackupRunRow }
  | { readonly kind: 'BUSY'; readonly holder: BackupRunRow }
  | { readonly kind: 'NOT_ADMITTED' };

export class TenantArchiveService {
  constructor(private readonly deps: TenantArchiveServiceDeps) {}

  /** One archive of `tenantId`, sealed with `password`, through the queue. */
  async run(input: {
    readonly tenantId: string;
    readonly trigger: BackupTrigger;
    readonly password: string;
  }): Promise<TenantArchiveOutcome> {
    const admitted = await this.deps.heavyJobs.runWhenAdmitted(
      'BACKUP',
      input.tenantId,
      () => this.runAdmitted(input),
      this.deps.queue,
    );
    return admitted.ran ? admitted.result : { kind: 'NOT_ADMITTED' };
  }

  private async runAdmitted(input: {
    readonly tenantId: string;
    readonly trigger: BackupTrigger;
    readonly password: string;
  }): Promise<TenantArchiveOutcome> {
    const now0 = this.deps.clock.now();
    await this.deps.runs.reclaimStale({
      staleBefore: new Date(now0.getTime() - BACKUP_LEASE_STALE_AFTER_MS),
      now: now0,
    });
    const id = this.deps.ids.uuid();
    const startedAt = this.deps.clock.now();
    const claim = await this.deps.runs.start({
      id,
      trigger: input.trigger,
      leaseOwner: this.deps.leaseOwner,
      now: startedAt,
      subjectTenantId: input.tenantId,
    });
    if (!claim.claimed) return { kind: 'BUSY', holder: claim.holder };

    const beat = setInterval(() => {
      void this.deps.runs
        .heartbeat({ id, leaseOwner: this.deps.leaseOwner, now: this.deps.clock.now() })
        .catch(() => undefined);
    }, BACKUP_LEASE_HEARTBEAT_MS);
    beat.unref?.();

    let stage: BackupStage = 'DUMP';
    const phaseDurationsMs: BackupPhaseDurationsMs = {};
    let lapAt = startedAt.getTime();
    const lap = (finished: BackupStage): void => {
      const at = this.deps.clock.now().getTime();
      phaseDurationsMs[finished] = Math.max(0, at - lapAt);
      lapAt = at;
    };
    const progress = async (next: BackupStage): Promise<void> => {
      stage = next;
      await this.deps.runs.progress({
        id,
        stage: next,
        leaseOwner: this.deps.leaseOwner,
        now: this.deps.clock.now(),
      });
    };
    let workspace: TenantArchiveWorkspace | null = null;
    let dumpBytes: bigint | null = null;
    let archiveBytes: bigint | null = null;
    let checksum: string | null = null;
    let verifiedAt: Date | null = null;
    try {
      // The claim and the exclusive ticket make this the only archive or restore: a tenant
      // scratch database still on the verify server is a killed one's (finding 2).
      const swept = await this.deps.engine.sweepAbandonedScratch();
      if (swept.dropped.length > 0 || swept.survived.length > 0) {
        this.deps.logger.error(
          { backupId: id, dropped: swept.dropped, survived: swept.survived },
          'tenant scratch databases a killed archive or restore left behind',
        );
      }
      // ---- DUMP ------------------------------------------------------------
      workspace = await this.deps.engine.workspace(input.tenantId, id);
      const dumped = await this.deps.engine.dump({
        tenantId: input.tenantId,
        directory: workspace.plainDirectory,
        archiveId: id,
        createdAt: startedAt,
        password: input.password,
      });
      lap('DUMP');
      // ---- CHECKSUM --------------------------------------------------------
      await progress('CHECKSUM');
      // Each part's SHA-256 is in the manifest; the run records the manifest's own.
      checksum = dumped.manifestSha256;
      dumpBytes = BigInt(dumped.dataBytes);
      lap('CHECKSUM');
      // ---- ENCRYPT ---------------------------------------------------------
      await progress('ENCRYPT');
      const sealed = await this.deps.engine.seal({
        directory: workspace.plainDirectory,
        archivePath: workspace.archivePath,
        password: input.password,
      });
      archiveBytes = BigInt(sealed.archiveBytes);
      lap('ENCRYPT');
      // ---- VERIFY_RESTORE --------------------------------------------------
      await progress('VERIFY_RESTORE');
      const verified = await this.deps.engine.verify({
        archivePath: workspace.archivePath,
        password: input.password,
        directory: workspace.verifyDirectory,
        expectedManifestSha256: dumped.manifestSha256,
      });
      verifiedAt = this.deps.clock.now();
      lap('VERIFY_RESTORE');
      this.deps.logger.info(
        { backupId: id, tenantId: input.tenantId, tables: verified.tables, rows: verified.rows },
        'tenant archive restored into a scratch database and checked',
      );
      const plaintextLeft = await workspace.discardPlaintext();
      // ---- DELIVER (only from a verified archive) ---------------------------
      await progress('DELIVER');
      let delivered: {
        readonly state: BackupDeliveryState;
        readonly detail: string | null;
        readonly attemptedAt: Date | null;
      } = {
        state: 'NOT_ATTEMPTED',
        detail: 'Kept on this server: hosted archives are not sent to the owner’s topic.',
        attemptedAt: null,
      };
      if (this.deps.delivery !== undefined) {
        try {
          delivered = await this.deps.delivery.deliver({
            tenantId: input.tenantId,
            runId: id,
            archivePath: workspace.archivePath,
            archiveBytes: sealed.archiveBytes,
            checksum: dumped.manifestSha256,
            at: this.deps.clock.now(),
          });
        } catch (error) {
          // A delivery that threw is not a failed archive: the verified file stays here.
          delivered = {
            state: 'FAILED_DEFINITIVE',
            detail: `The hosted group delivery failed: ${storedFailureMessage(error)}`.slice(
              0,
              500,
            ),
            attemptedAt: this.deps.clock.now(),
          };
        }
      }
      lap('DELIVER');
      // ---- CLEANUP ---------------------------------------------------------
      stage = 'CLEANUP';
      const leftovers = [...plaintextLeft, ...this.deps.engine.leaked];
      lap('CLEANUP');
      await this.deps.runs.finish({
        id,
        leaseOwner: this.deps.leaseOwner,
        state: 'SUCCEEDED',
        stage: 'CLEANUP',
        now: this.deps.clock.now(),
        phaseDurationsMs,
        dumpBytes,
        archiveBytes,
        checksum,
        verifiedAt,
        deliveryState: delivered.state,
        deliveryAttemptedAt: delivered.attemptedAt,
        deliveryDetail: delivered.detail,
        cleanupOk: leftovers.length === 0,
        cleanupDetail: leftovers.length === 0 ? null : leftovers.join(', '),
        archiveFormat: 'SEVEN_ZIP',
      });
    } catch (error) {
      const failureCode = error instanceof NexaError ? error.code : 'backup.failed';
      // Never the raw message: a failed statement's carries the row's values (finding 1).
      const failureMessage = storedFailureMessage(error);
      this.deps.logger.error(
        { backupId: id, tenantId: input.tenantId, stage, failureCode },
        'tenant archive run failed',
      );
      // Unproven or not: a run that failed takes its archive with it — except one that
      // verified, which retention decides like any other.
      const left =
        workspace === null
          ? []
          : verifiedAt === null
            ? await workspace.discardAll()
            : await workspace.discardPlaintext();
      const leftovers = [...left, ...this.deps.engine.leaked];
      lap(stage);
      await this.deps.runs.finish({
        id,
        leaseOwner: this.deps.leaseOwner,
        state: 'FAILED',
        stage,
        now: this.deps.clock.now(),
        phaseDurationsMs,
        dumpBytes,
        archiveBytes,
        checksum,
        verifiedAt,
        deliveryState: 'NOT_ATTEMPTED',
        failureCode,
        failureMessage,
        cleanupOk: leftovers.length === 0,
        cleanupDetail: leftovers.length === 0 ? null : leftovers.join(', '),
        archiveFormat: archiveBytes === null ? null : 'SEVEN_ZIP',
      });
    } finally {
      clearInterval(beat);
    }
    const run = await this.deps.runs.byId(id);
    if (run === null) {
      throw new NexaError({
        kind: 'INTERNAL',
        code: PLATFORM_ERROR_CODES.BACKUP_RUN_MISSING,
        message: 'A tenant archive run finished and its row could not be read back.',
      });
    }
    return { kind: 'COMPLETED', run };
  }
}

// ---------------------------------------------------------------------------
// Restore (ADR-0039 § 3, § 4)
// ---------------------------------------------------------------------------

export interface TenantRestoreSummary {
  readonly hostedTenantId: string;
  readonly archiveId: string;
  readonly head: 'EQUAL' | 'OLDER';
  readonly slug: string;
  /** Rows per table: the verified scratch's, or (applied) the live copy's. */
  readonly counts: Readonly<Record<string, number>>;
}

export interface TenantRestoreEngine {
  /** SHA-256 of the uploaded archive file: the request and its confirmation are bound to it. */
  sha256(archivePath: string): Promise<string>;
  /**
   * Opens and verifies the archive in a scratch database at its head, migrates the scratch up
   * to this release's head, runs every refusal check, and — only when `apply` — copies it into
   * the live database in one transaction. The scratch is dropped either way.
   *
   * Security review of PR #447, finding 5: the archive is first copied into the private
   * `directory` through a SHA-256, and every later read is of that copy; a copy whose hash is
   * not `expectedSha256` (the file the request or its confirmation is bound to) is refused
   * before anything is opened. Finding 4: a connection that bypasses row-level security is
   * refused before anything else.
   */
  restore(input: {
    readonly archivePath: string;
    readonly expectedSha256: string;
    readonly password: string;
    readonly directory: string;
    readonly installationTenantId: string;
    readonly actorAdminId: string;
    readonly slug?: string;
    readonly apply: boolean;
    readonly onOpened: (manifest: TenantArchiveManifest) => Promise<void>;
    readonly onStage: (stage: TenantRestoreStage) => Promise<void>;
  }): Promise<TenantRestoreSummary>;
  /** As `TenantArchiveEngine.sweepAbandonedScratch`. */
  sweepAbandonedScratch(): Promise<ScratchSweep>;
}

export interface TenantRestoreRepository {
  create(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly hostedTenantId: string;
      readonly mode: TenantRestoreMode;
      readonly artifactSha256: string;
      readonly archiveId: string;
      readonly requestedByAdminId: string;
      readonly leaseOwner: string;
      readonly now: Date;
    },
  ): Promise<void>;
  /**
   * The owner's confirmation of a VERIFIED dry run: VERIFIED → VERIFYING with `confirmed_at`
   * and this process's lease, only for the same archive file (its SHA-256). Returns the hosted
   * tenant, or null when no such verified request exists.
   */
  confirm(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly artifactSha256: string;
      readonly leaseOwner: string;
      readonly now: Date;
    },
  ): Promise<{ readonly hostedTenantId: string } | null>;
  /** Refreshes the lease of a request this process is working on. */
  heartbeat(
    scope: TenantContext,
    input: { readonly id: string; readonly leaseOwner: string; readonly now: Date },
  ): Promise<void>;
  /**
   * Finding 3: FAILS (`tenant_archive.lease_expired`) every in-progress request whose lease
   * was last refreshed before `staleBefore` — never adopts one — and returns how many.
   */
  reclaimStale(
    scope: TenantContext,
    input: { readonly staleBefore: Date; readonly now: Date },
  ): Promise<number>;
  stage(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly stage: TenantRestoreStage;
      readonly applying: boolean;
      readonly leaseOwner: string;
      readonly now: Date;
    },
  ): Promise<void>;
  finish(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly state: 'VERIFIED' | 'SUCCEEDED' | 'FAILED';
      readonly dryRun?: Readonly<Record<string, unknown>>;
      readonly failureCode?: string;
      readonly failureMessage?: string;
      readonly leaseOwner: string;
      readonly now: Date;
    },
  ): Promise<void>;
}

export class TenantRestoreService {
  constructor(
    private readonly deps: {
      readonly engine: TenantRestoreEngine;
      readonly requests: TenantRestoreRepository;
      readonly heavyJobs: HeavyJobRunner;
      readonly clock: Clock;
      readonly ids: IdGenerator;
      /** Names this process on the request rows it works on (ADR-0025's lease). */
      readonly leaseOwner: string;
      readonly queue: TenantArchiveServiceDeps['queue'];
    },
  ) {}

  /**
   * One restore of an uploaded tenant archive. Without `confirmRequestId` it is the dry run:
   * everything up to and including the refusal checks, nothing written to the live database,
   * the request row left VERIFIED. With it — the owner's confirmation of that row, for the same
   * file (its SHA-256) — the whole verification is repeated and then applied. `REPLACE` is refused until the tenant
   * rewrite allowance exists (ADR-0039 § 10).
   */
  async restore(input: {
    readonly installationTenantId: string;
    readonly actorAdminId: string;
    readonly archivePath: string;
    readonly password: string;
    readonly directory: string;
    readonly mode: TenantRestoreMode;
    readonly slug?: string;
    /** Absent: a dry run. Present: the confirmation of that VERIFIED dry run, which applies. */
    readonly confirmRequestId?: string;
    /** A dry run's request id, chosen by the caller (its upload is filed under it). */
    readonly requestId?: string;
  }): Promise<{ readonly requestId: string; readonly summary: TenantRestoreSummary } | null> {
    if (input.mode === 'REPLACE') {
      throw new NexaError({
        kind: 'PRECONDITION_FAILED',
        code: TENANT_ARCHIVE_ERROR_CODES.REPLACE_UNAVAILABLE,
        message:
          'Restoring over an existing hosted tenant needs the tenant rewrite allowance, which is ' +
          'not built (ADR-0039 § 10). Restore it as a new hosted bot.',
      });
    }
    const scope: TenantContext = {
      tenantId: input.installationTenantId as TenantContext['tenantId'],
      botInstanceId: null,
    };
    const leaseOwner = this.deps.leaseOwner;
    const artifactSha256 = await this.deps.engine.sha256(input.archivePath);
    const apply = input.confirmRequestId !== undefined;
    const id = input.confirmRequestId ?? input.requestId ?? this.deps.ids.uuid();
    let confirmedTenant: string | null = null;
    let created = false;
    const admitted = await this.deps.heavyJobs.runWhenAdmitted(
      'RESTORE',
      input.installationTenantId,
      async () => {
        // Finding 3: a restore whose process died holds the one restore slot until its lease
        // is taken over — by FAILING it, never by adopting it (ADR-0025). The ticket is an
        // exclusive kind, so no live restore or archive runs beside this one; its scratch
        // databases likewise (finding 2).
        const now0 = this.deps.clock.now();
        await this.deps.requests.reclaimStale(scope, {
          staleBefore: new Date(now0.getTime() - BACKUP_LEASE_STALE_AFTER_MS),
          now: now0,
        });
        await this.deps.engine.sweepAbandonedScratch();
        if (apply) {
          // Confirm only once admitted: a refused admission must leave the row VERIFIED (retryable),
          // not stranded in VERIFYING behind the single-active-restore index.
          const confirmed = await this.deps.requests.confirm(scope, {
            id,
            artifactSha256,
            leaseOwner,
            now: this.deps.clock.now(),
          });
          if (confirmed === null) {
            throw new NexaError({
              kind: 'PRECONDITION_FAILED',
              code: TENANT_ARCHIVE_ERROR_CODES.VERIFICATION_FAILED,
              message: 'There is no verified dry run of this archive file to confirm.',
            });
          }
          confirmedTenant = confirmed.hostedTenantId;
          created = true;
        }
        const beat = setInterval(() => {
          if (!created) return;
          void this.deps.requests
            .heartbeat(scope, { id, leaseOwner, now: this.deps.clock.now() })
            .catch(() => undefined);
        }, BACKUP_LEASE_HEARTBEAT_MS);
        beat.unref?.();
        try {
          const summary = await this.deps.engine.restore({
            archivePath: input.archivePath,
            // Finding 5: the bytes the engine reads are the bytes this request is bound to.
            expectedSha256: artifactSha256,
            password: input.password,
            directory: input.directory,
            installationTenantId: input.installationTenantId,
            actorAdminId: input.actorAdminId,
            ...(input.slug === undefined ? {} : { slug: input.slug }),
            apply,
            onOpened: async (manifest) => {
              if (apply) {
                // The confirmation is of THIS tenant's dry run; another archive under the same
                // file name is not it (the SHA-256 already bound the file).
                if (manifest.tenant.id !== confirmedTenant) {
                  throw new NexaError({
                    kind: 'PRECONDITION_FAILED',
                    code: TENANT_ARCHIVE_ERROR_CODES.VERIFICATION_FAILED,
                    message: 'The archive is not the one the dry run verified.',
                  });
                }
                return;
              }
              await this.deps.requests.create(scope, {
                id,
                hostedTenantId: manifest.tenant.id,
                mode: input.mode,
                artifactSha256,
                archiveId: manifest.archiveId,
                requestedByAdminId: input.actorAdminId,
                leaseOwner,
                now: this.deps.clock.now(),
              });
              created = true;
            },
            // The row exists from the moment the archive is open (it names the tenant).
            onStage: async (stage) => {
              if (!created) return;
              await this.deps.requests.stage(scope, {
                id,
                stage,
                applying: stage === 'APPLY',
                leaseOwner,
                now: this.deps.clock.now(),
              });
            },
          });
          await this.deps.requests.finish(scope, {
            id,
            state: apply ? 'SUCCEEDED' : 'VERIFIED',
            dryRun: { head: summary.head, slug: summary.slug, counts: summary.counts },
            leaseOwner,
            now: this.deps.clock.now(),
          });
          return { requestId: id, summary };
        } catch (error) {
          if (created) {
            await this.deps.requests.finish(scope, {
              id,
              state: 'FAILED',
              failureCode:
                error instanceof NexaError
                  ? error.code
                  : TENANT_ARCHIVE_ERROR_CODES.VERIFICATION_FAILED,
              // Never the raw message: a failed INSERT's carries the archive's row (finding 1).
              failureMessage: storedFailureMessage(error),
              leaseOwner,
              now: this.deps.clock.now(),
            });
          }
          throw error;
        } finally {
          clearInterval(beat);
        }
      },
      this.deps.queue,
    );
    return admitted.ran ? admitted.result : null;
  }
}
