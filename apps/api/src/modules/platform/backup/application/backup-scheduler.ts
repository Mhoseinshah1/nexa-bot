import type { Clock } from '@nexa/contracts';
import type { BackupRunRepository } from './ports.js';
import type { BackupService } from './backup.service.js';

/**
 * Takes a backup on a schedule, in the worker role.
 *
 * Deliberately thin: it decides WHEN, and `BackupService.run` decides
 * everything else. There is no scheduled variant of the pipeline, no scheduled
 * variant of the lock and no scheduled variant of the verification — the
 * trigger is a recorded field and nothing branches on it. A separate scheduled
 * path is how the unattended backup, which is the one that matters, comes to
 * differ from the manual one, which is the one somebody watches.
 *
 * DUE IS COMPUTED FROM THE LAST SUCCESSFUL RUN, not from this process's start.
 * A worker that restarts every twenty minutes would otherwise take a backup
 * every twenty minutes, and a failing run would reset the clock as though it
 * had worked. The state is in the table, so a restart resumes rather than
 * restarts, and two replicas ticking at once contend on the lock rather than on
 * a decision either of them made.
 */
export interface BackupSchedulerDeps {
  readonly service: BackupService;
  readonly runs: BackupRunRepository;
  readonly clock: Clock;
  /** How long after the last successful backup the next one is due. */
  readonly intervalMs: number;
  /** How often to ask. Much shorter than the interval; asking is cheap. */
  readonly tickIntervalMs: number;
  readonly logger: {
    info(context: Record<string, unknown>, message: string): void;
    warn(context: Record<string, unknown>, message: string): void;
    error(context: Record<string, unknown>, message: string): void;
  };
}

export class BackupScheduler {
  private timer: NodeJS.Timeout | null = null;
  /**
   * Guards against a tick starting while the previous one is still running.
   *
   * The database lock already makes a second concurrent backup impossible; this
   * stops the process from stacking awaited ticks behind a dump that takes
   * longer than the tick interval, which would turn a slow backup into an
   * unbounded queue of pending timers.
   */
  private ticking = false;
  /**
   * Whether a tick has completed since start, and when it last made progress.
   *
   * Read by the worker's health check. "The process exists" is not the same
   * claim as "the scheduled backup is running", and a role whose whole job is
   * unattended work has to be able to tell them apart.
   */
  private lastTickAt: number | null = null;

  constructor(private readonly deps: BackupSchedulerDeps) {}

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
   * Whether the scheduler is doing its job, for the worker's health check.
   *
   * Progress-based, not existence-based: a scheduler whose ticks are all
   * throwing has a live timer and is not working. Three intervals of slack, so
   * one slow tick is not an outage.
   */
  isFresh(nowMs: number): boolean {
    if (this.lastTickAt === null) return false;
    return nowMs - this.lastTickAt <= this.deps.tickIntervalMs * 3;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.deps.clock.now();
      const last = await this.deps.runs.lastSucceededAt();
      const dueAt = last === null ? 0 : last.getTime() + this.deps.intervalMs;
      // A never-backed-up installation is due immediately. That is the correct
      // reading of "no backup exists", and it is also what makes the first run
      // after an install happen without anybody remembering to ask for one.
      if (now.getTime() < dueAt) {
        this.lastTickAt = now.getTime();
        return;
      }

      const outcome = await this.deps.service.run('SCHEDULED');
      if (outcome.kind === 'BUSY') {
        // Two replicas, one lock. Expected on every rolling update, and not a
        // problem: the other one is taking the backup.
        this.deps.logger.info(
          { holder: outcome.holder.id, since: outcome.holder.startedAt.toISOString() },
          'scheduled backup skipped; another process holds the backup lock',
        );
      } else if (outcome.run.state === 'FAILED') {
        this.deps.logger.error(
          { backupId: outcome.run.id, stage: outcome.run.stage, code: outcome.run.failureCode },
          'scheduled backup failed',
        );
      } else {
        this.deps.logger.info(
          { backupId: outcome.run.id, delivery: outcome.run.deliveryState },
          'scheduled backup completed',
        );
      }
      this.lastTickAt = this.deps.clock.now().getTime();
    } catch (error) {
      // Never swallowed, and never fatal to the loop: a tick that throws must
      // not stop the scheduler, or one transient database error ends scheduled
      // backups for the life of the process. `lastTickAt` is deliberately NOT
      // advanced, so a run of failing ticks makes the health check say so.
      this.deps.logger.error(
        { reason: error instanceof Error ? error.message : String(error) },
        'backup scheduler tick failed',
      );
    } finally {
      this.ticking = false;
    }
  }
}
