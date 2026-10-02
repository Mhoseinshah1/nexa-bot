import type { Clock } from '@nexa/contracts';
import { LoopProgress } from '../../../../infrastructure/lifecycle/loop-progress.js';
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
 *
 * WHETHER AND HOW OFTEN are asked on every tick (spec §13.2), of the settings
 * registry with the environment as the default — so the Web Admin's switch takes
 * effect within one tick, with no restart, and a worker started with the schedule
 * "off" still picks it up when an operator turns it on. That is also why this loop
 * is always started: a disabled schedule is a tick that decides nothing is due,
 * not a loop that does not exist.
 */
export interface BackupSchedulerDeps {
  readonly service: BackupService;
  readonly runs: BackupRunRepository;
  /**
   * Whether a recovery currently holds the installation.
   *
   * A question rather than a repository, so the backup module does not depend on
   * the recovery module — the same shape `InstallationWriteGate` uses, and for
   * the same reason.
   */
  readonly quiesced: () => Promise<boolean>;
  readonly clock: Clock;
  /**
   * The schedule in force NOW: on/off, and how long after the last successful backup
   * the next one is due. `BackupSchedulePolicy.effective` in production.
   */
  readonly schedule: () => Promise<{ readonly enabled: boolean; readonly intervalMs: number }>;
  /** How often to ask. Much shorter than the interval; asking is cheap. */
  readonly tickIntervalMs: number;
  /**
   * The longest one backup run can legitimately take: the dump, restore and delivery
   * ceilings together, plus slack. While a run this process started is younger than
   * this, the scheduler is working — it is waiting on `pg_dump`, not stalled. Each of
   * those stages has its own timeout, so a run cannot be in flight for longer than this
   * unless something below them has hung, which is exactly when health should say so.
   */
  readonly maxRunMs: number;
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
   * The database lock already makes a second concurrent backup impossible — across
   * processes and replicas, by the partial unique index. This stops the process from
   * stacking awaited ticks behind a dump that takes longer than the tick interval, and
   * it is what keeps the immediate tick `start()` fires from overlapping the first timer
   * tick: whichever arrives second returns at once.
   */
  private ticking = false;
  /**
   * Whether ticks are completing, measured by the shared `LoopProgress` (spec §14).
   *
   * The clock starts at `start()`, so a worker that has just booted is healthy for one
   * slack window before any tick has completed — the absence of progress three seconds
   * after start is not evidence of failure. Before this, `lastTickAt` began null and
   * `isFresh` answered false until the first tick, which `setInterval` delivered one
   * whole `BACKUP_TICK_MS` (five minutes) after start: longer than the container health
   * check waits, so a fresh deploy with backups on reported the worker unhealthy, and the
   * production workaround was `BACKUP_TICK_MS=30000`. That workaround is no longer needed
   * — and `start()` also runs a first tick at once, so progress is normally recorded
   * within seconds rather than merely tolerated.
   */
  private readonly progress: LoopProgress;
  /** When the backup run this process is waiting on began, or null when none is. */
  private runStartedAt: number | null = null;

  constructor(private readonly deps: BackupSchedulerDeps) {
    this.progress = new LoopProgress(deps.tickIntervalMs);
  }

  start(): void {
    if (this.timer !== null) return;
    this.progress.begin(this.deps.clock.now().getTime());
    this.timer = setInterval(() => void this.tick(), this.deps.tickIntervalMs);
    this.timer.unref();
    // The immediate, safe initial check (spec §14): asks the table whether a backup is
    // due rather than waiting a whole tick interval to find out. Safe to fire beside the
    // timer — `ticking` makes the second one return — and beside another replica — the
    // partial unique index makes the second one BUSY.
    void this.tick();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
    this.progress.end();
  }

  /**
   * Whether the scheduler is doing its job, for the worker's health check.
   *
   * Progress-based, not existence-based: a scheduler whose ticks are all throwing has a
   * live timer and is not working. Three tick intervals of slack, so one slow tick is not
   * an outage — and a run in flight is working for as long as a run can take, so a
   * two-hour dump does not make the worker unhealthy at minute sixteen.
   */
  isFresh(nowMs: number): boolean {
    if (this.runStartedAt !== null && nowMs - this.runStartedAt <= this.deps.maxRunMs) {
      return true;
    }
    return this.progress.isFresh(nowMs);
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const schedule = await this.deps.schedule();
      if (!schedule.enabled) {
        // Off is a decision, not a fault: the tick completed and found nothing to do.
        this.progress.record(this.deps.clock.now().getTime());
        return;
      }

      const now = this.deps.clock.now();
      const last = await this.deps.runs.lastSucceededAt();
      const dueAt = last === null ? 0 : last.getTime() + schedule.intervalMs;
      // A never-backed-up installation is due immediately. That is the correct
      // reading of "no backup exists", and it is also what makes the first run
      // after an install happen without anybody remembering to ask for one.
      if (now.getTime() < dueAt) {
        this.progress.record(now.getTime());
        return;
      }

      /*
       * NOT DURING A RECOVERY.
       *
       * `backup_runs` is written on the database handle rather than through the
       * unit of work, so no backup write passes either quiesce chokepoint — the
       * gate cannot stop this one, and the operator's own button is checked at
       * its surface for exactly that reason. The scheduler is the caller that
       * needs the check MORE, because nobody is watching it.
       *
       * The window is real and small: the recovery's own pre-restore backup
       * releases the one-at-a-time lock as it finishes, and the executor moves to
       * QUIESCING immediately after. A scheduler tick landing between those two
       * starts a full dump against a database that is about to be renamed out
       * from under it — killed mid-`pg_dump` by the cutover's terminate, or worse
       * surviving into a stage whose conditional writes then match nothing in the
       * restored database, delivering an archive to Telegram with no run row
       * behind it.
       *
       * An earlier comment on `BackupAdminService.run` justified leaving the
       * scheduler unchecked by saying it is the pre-restore backup's own path.
       * It is not: the executor calls `BackupService.run('PRE_RESTORE')` directly.
       */
      if (await this.deps.quiesced()) {
        this.deps.logger.info({}, 'scheduled backup skipped; a recovery holds the installation');
        this.progress.record(now.getTime());
        return;
      }

      this.runStartedAt = now.getTime();
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
      this.progress.record(this.deps.clock.now().getTime());
    } catch (error) {
      // Never swallowed, and never fatal to the loop: a tick that throws must
      // not stop the scheduler, or one transient database error ends scheduled
      // backups for the life of the process. Progress is deliberately NOT
      // recorded, so a run of failing ticks makes the health check say so.
      this.deps.logger.error(
        { reason: error instanceof Error ? error.message : String(error) },
        'backup scheduler tick failed',
      );
    } finally {
      this.runStartedAt = null;
      this.ticking = false;
    }
  }
}
