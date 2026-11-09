import { LoopProgress } from '../../../../infrastructure/lifecycle/loop-progress.js';
import { guardedTick } from '../../../../infrastructure/lifecycle/loop-guard.js';
import type { HostedBackupService } from './hosted-backup.service.js';

/** How often the worker looks for a due hosted archive (the schedule is per minute). */
export const HOSTED_BACKUP_TICK_MS = 60_000;

/**
 * Phase 6B PR-2: the worker's timer over `HostedBackupService.runDue` — every hosted bot's
 * scheduled and requested archives, one at a time through the heavy-job queue. Its own file
 * because it carries `isFresh` (`worker-health-coverage.test.ts`). A pass in progress is fresh
 * (an archive of a large bot runs for minutes, kept alive by its own lease heartbeat); a pass
 * that threw records no progress, so a schedule that cannot run goes stale rather than silent.
 * Idle during a recovery, like every lane that writes.
 */
export class HostedBackupLoop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly progress: LoopProgress;

  constructor(
    private readonly service: Pick<HostedBackupService, 'runDue'>,
    private readonly options: {
      readonly intervalMs: number;
      readonly now: () => number;
      readonly quiesced: () => Promise<boolean>;
      readonly logger: {
        info: (context: Record<string, unknown>, message: string) => void;
        error: (context: Record<string, unknown>, message: string) => void;
      };
    },
  ) {
    this.progress = new LoopProgress(options.intervalMs);
  }

  isFresh(nowMs: number): boolean {
    return this.running || this.progress.isFresh(nowMs);
  }

  start(): void {
    if (this.timer !== null) return;
    this.progress.begin(this.options.now());
    this.timer = setInterval(
      guardedTick('hosted-backups', () => this.tick(), this.options.logger),
      this.options.intervalMs,
    );
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 10));
    this.progress.end();
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (!(await this.options.quiesced())) {
        const pass = await this.service.runDue();
        if (pass.ran.length > 0 || pass.failed.length > 0 || pass.pruned > 0) {
          this.options.logger.info(
            {
              ran: pass.ran.length,
              failed: pass.failed.length,
              pruned: pass.pruned,
              deferred: pass.deferred,
            },
            'hosted backup pass',
          );
        }
      }
      this.progress.record(this.options.now());
    } catch (error: unknown) {
      this.options.logger.error({ err: error }, 'hosted backup pass failed');
    } finally {
      this.running = false;
    }
  }
}
