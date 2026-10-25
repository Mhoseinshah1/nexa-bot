import { systemJobActor, type CorrelationId, type TenantContext } from '@nexa/contracts';
import { LoopProgress } from '../../../../infrastructure/lifecycle/loop-progress.js';
import type { DataCompactionService } from './data-compaction.service.js';
import type { DataCompactionRepository } from './ports.js';

/** How often the loop wakes. A pass is daily (`DATA_COMPACTION_DAILY_MS`); the hour is a retry. */
export const DATA_COMPACTION_INTERVAL_MS = 3_600_000;
/** After boot, so housekeeping does not compete with startup. */
export const DATA_COMPACTION_INITIAL_DELAY_MS = 10 * 60_000;
/**
 * A COMPLETED worker pass is not repeated for this long. Durable — read from the run rows, not
 * a process timer — so a crash loop, a day of deploys and two replicas still run one pass a
 * day. A pass that STOPPED (a backup was running, the batch ceiling) or FAILED is retried on
 * the next hour.
 */
export const DATA_COMPACTION_DAILY_MS = 20 * 3_600_000;

/**
 * The worker's timer for the data compaction (Round 9 C3). Its own file: the worker health
 * coverage test marks every class declaring `isFresh` in a file as freshness-bearing.
 *
 * It acts as `SYSTEM_JOB` (which holds `maintenance.run` and nothing else) on the installation
 * tenant, and follows `retention.compaction_mode`: in DRY_RUN — the default — a pass records
 * what it WOULD remove and removes nothing.
 */
export class DataCompactionLoop {
  private timer: NodeJS.Timeout | null = null;
  private firstRun: NodeJS.Timeout | null = null;
  private running = false;
  private readonly progress: LoopProgress;

  constructor(
    private readonly service: DataCompactionService,
    private readonly runs: Pick<DataCompactionRepository, 'latest'>,
    private readonly options: {
      readonly scope: () => TenantContext | null;
      readonly intervalMs: number;
      readonly initialDelayMs: number;
      readonly now: () => number;
      readonly correlationId: () => string;
      readonly logger: {
        info: (context: Record<string, unknown>, message: string) => void;
        error: (context: Record<string, unknown>, message: string) => void;
      };
    },
  ) {
    this.progress = new LoopProgress(options.intervalMs);
  }

  isFresh(nowMs: number): boolean {
    return this.progress.isFresh(nowMs);
  }

  start(): void {
    if (this.timer !== null) return;
    this.progress.begin(this.options.now());
    this.firstRun = setTimeout(() => void this.tick(), this.options.initialDelayMs);
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
    this.firstRun.unref?.();
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.firstRun !== null) {
      clearTimeout(this.firstRun);
      this.firstRun = null;
    }
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 10));
    this.progress.end();
  }

  /** One wake-up; public so a test can drive exactly one. Re-entrancy is refused, not queued. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const scope = this.options.scope();
      if (scope !== null && (await this.due(scope))) {
        const actor = systemJobActor(
          'data-compaction',
          this.options.correlationId() as CorrelationId,
        );
        const outcome = await this.service.run(scope, actor, {
          trigger: 'WORKER',
          mode: 'SETTING',
        });
        if (outcome.kind === 'RAN') {
          this.options.logger.info(
            {
              runId: outcome.run.id,
              mode: outcome.run.mode,
              state: outcome.run.state,
              counts: outcome.run.counts,
            },
            'data compaction pass finished',
          );
        }
      }
      this.progress.record(this.options.now());
    } catch (error: unknown) {
      this.options.logger.error({ err: error }, 'data compaction pass failed');
    } finally {
      this.running = false;
    }
  }

  private async due(scope: TenantContext): Promise<boolean> {
    const last = await this.runs.latest(scope.tenantId, { trigger: 'WORKER' });
    if (last === null || last.state !== 'COMPLETED') return true;
    return this.options.now() - last.startedAt.getTime() >= DATA_COMPACTION_DAILY_MS;
  }
}
