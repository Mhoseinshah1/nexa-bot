import {
  DATA_EXPORT_ERROR_CODES,
  DATA_EXPORT_TTL_MS,
  isNexaError,
  type Clock,
  type TenantContext,
} from '@nexa/contracts';
import { guardedTick } from '../../../../infrastructure/lifecycle/loop-guard.js';
import type {
  DataExportFiles,
  DataExportQueue,
  DataExportRepository,
  DataExportRow,
  DataExportWriter,
} from './ports.js';

export interface DataExportRunnerDeps {
  readonly repository: DataExportRepository;
  readonly files: DataExportFiles;
  readonly writer: DataExportWriter;
  /** The heavy-job queue (`HeavyJobGate`): an export is kind `EXPORT`. */
  readonly queue: DataExportQueue;
  readonly clock: Clock;
  readonly leaseOwner: string;
  readonly tickIntervalMs: number;
  readonly queueOptions: {
    readonly pollMs: number;
    readonly maxWaitMs: number;
    readonly sleep: (ms: number) => Promise<void>;
  };
  /** How often a claimed export says it is alive, and how long silence makes it abandoned. */
  readonly heartbeatMs: number;
  readonly staleAfterMs: number;
  /** An export a worker dies in is retried by another this many times in all. */
  readonly maxAttempts: number;
  readonly logger: {
    info(context: Record<string, unknown>, message: string): void;
    warn(context: Record<string, unknown>, message: string): void;
    error(context: Record<string, unknown>, message: string): void;
  };
}

const REMOVAL_BATCH = 50;

/**
 * Phase 6B PR-3: the worker's side of the open data export. One tick:
 *
 *   1. the 24 h deadline — READY exports past it become EXPIRED and their files are removed
 *      (a file whose removal failed is retried on the next tick, from the row, so no file
 *      outlives its link);
 *   2. abandoned work — a RUNNING export whose worker went silent and that used every attempt
 *      ends FAILED (`data_export.failed`);
 *   3. one export — the oldest REQUESTED (or abandoned RUNNING) is CLAIMED, then waits for the
 *      heavy-job queue (`HeavyJobGate`, kind `EXPORT`: never beside a backup or a restore),
 *      writes its ZIP, and ends READY with a 24 h deadline, or FAILED with a code. Not
 *      admitted this time → back to REQUESTED, still first in line.
 *
 * Several workers may run it: the claim is `FOR UPDATE SKIP LOCKED`, and every later write is
 * conditional on the lease.
 */
export class DataExportRunner {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private lastTickAt: number | null = null;

  constructor(private readonly deps: DataExportRunnerDeps) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(
      guardedTick('data-export-runner', () => this.tick(), this.deps.logger),
      this.deps.tickIntervalMs,
    );
    this.timer.unref?.();
    this.lastTickAt = this.deps.clock.now().getTime();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Idle is fresh, and so is a tick in progress (an export is long); silence is not. */
  isFresh(nowMs: number): boolean {
    if (this.ticking) return true;
    return this.lastTickAt !== null && nowMs - this.lastTickAt <= this.deps.tickIntervalMs * 3;
  }

  /** One pass. Exposed so a test runs it without a timer. Returns the export it made, if any. */
  async tick(): Promise<DataExportRow | null> {
    if (this.ticking) return null;
    this.ticking = true;
    try {
      const now = this.deps.clock.now();
      await this.sweep(now);
      const claimed = await this.deps.repository.claimNext({
        now,
        staleBefore: new Date(now.getTime() - this.deps.staleAfterMs),
        leaseOwner: this.deps.leaseOwner,
        maxAttempts: this.deps.maxAttempts,
      });
      const made = claimed === null ? null : await this.run(claimed);
      this.lastTickAt = this.deps.clock.now().getTime();
      return made;
    } finally {
      this.ticking = false;
    }
  }

  private async sweep(now: Date): Promise<void> {
    await this.deps.repository.failAbandoned({
      now,
      staleBefore: new Date(now.getTime() - this.deps.staleAfterMs),
      maxAttempts: this.deps.maxAttempts,
    });
    await this.deps.repository.expireDue(now);
    for (const row of await this.deps.repository.pendingRemoval(REMOVAL_BATCH)) {
      try {
        if (row.fileName !== null) await this.deps.files.remove(row.tenantId, row.fileName);
        await this.deps.repository.markRemoved(scopeOf(row), row.id, this.deps.clock.now());
      } catch (error) {
        // Kept EXPIRED and unmarked: the next tick tries again.
        this.deps.logger.warn(
          { exportId: row.id, err: error instanceof Error ? error.message : String(error) },
          'an expired data export file could not be removed; retrying next tick',
        );
      }
    }
  }

  private async run(row: DataExportRow): Promise<DataExportRow | null> {
    const scope = scopeOf(row);
    const lease = { id: row.id, leaseOwner: this.deps.leaseOwner };
    const beat = setInterval(() => {
      void this.deps.repository
        .heartbeat(scope, { ...lease, now: this.deps.clock.now() })
        .catch(() => undefined);
    }, this.deps.heartbeatMs);
    beat.unref?.();
    const target = this.deps.files.pathFor(row.tenantId, row.id);
    try {
      const admitted = await this.deps.queue.runWhenAdmitted(
        'EXPORT',
        row.tenantId,
        async () =>
          this.deps.writer.write({
            tenantId: row.tenantId,
            path: target.path,
            generatedAt: this.deps.clock.now(),
          }),
        this.deps.queueOptions,
      );
      if (!admitted.ran) {
        await this.deps.repository.release(scope, { ...lease, now: this.deps.clock.now() });
        this.deps.logger.info(
          { exportId: row.id },
          'a data export was not admitted to the heavy-job queue this time',
        );
        return null;
      }
      const now = this.deps.clock.now();
      const ready = await this.deps.repository.markReady(scope, {
        ...lease,
        fileName: target.fileName,
        bytes: admitted.result.bytes,
        sha256: admitted.result.sha256,
        now,
        expiresAt: new Date(now.getTime() + DATA_EXPORT_TTL_MS),
      });
      if (!ready) {
        // The lease was lost (another worker took it over): this file is nobody's.
        await this.deps.files.remove(row.tenantId, target.fileName);
        return null;
      }
      this.deps.logger.info(
        { exportId: row.id, tenantId: row.tenantId, bytes: admitted.result.bytes },
        'a data export is ready',
      );
      return { ...row, state: 'READY', fileName: target.fileName };
    } catch (error) {
      await this.deps.files.remove(row.tenantId, target.fileName).catch(() => undefined);
      const code =
        isNexaError(error) && error.code === DATA_EXPORT_ERROR_CODES.TOO_LARGE
          ? DATA_EXPORT_ERROR_CODES.TOO_LARGE
          : DATA_EXPORT_ERROR_CODES.FAILED;
      await this.deps.repository
        .markFailed(scope, { ...lease, failureCode: code, now: this.deps.clock.now() })
        .catch(() => undefined);
      this.deps.logger.error(
        { exportId: row.id, tenantId: row.tenantId, code, err: error },
        'a data export failed',
      );
      return null;
    } finally {
      clearInterval(beat);
    }
  }
}

function scopeOf(row: DataExportRow): TenantContext {
  return { tenantId: row.tenantId, botInstanceId: null } as TenantContext;
}
