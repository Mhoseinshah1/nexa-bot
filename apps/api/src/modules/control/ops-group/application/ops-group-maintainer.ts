import type { ActorContext, TenantContext } from '@nexa/contracts';
import { LoopProgress } from '../../../../infrastructure/lifecycle/loop-progress.js';
import type { OpsGroupService } from './ops-group.service.js';

/**
 * How often the worker looks at the operations log group. A group that was just bound is
 * UNVERIFIED until this runs, so it is short; a pass that finds nothing due makes no
 * Telegram call at all.
 */
export const OPS_GROUP_MAINTAIN_INTERVAL_MS = 15_000;

/**
 * The timer around `OpsGroupService.maintain`, in the `ReceiptReviewPushLoop` shape: one
 * pass at a time, a failed pass logged and the next one run, freshness reported to the
 * worker's health, and the installation's own tenant as the scope.
 *
 * What a pass does: checks a newly bound group, or one Telegram said changed, or one that
 * has had a problem for five minutes; creates the topics Nexa owns; and, once the group is
 * healthy, puts the preserved messages back in the queue.
 */
export class OpsGroupMaintainer {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly progress: LoopProgress;

  constructor(
    private readonly service: OpsGroupService,
    private readonly options: {
      readonly scope: () => TenantContext | null;
      readonly actor: () => ActorContext;
      readonly intervalMs: number;
      readonly now: () => number;
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
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
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
      const scope = this.options.scope();
      if (scope !== null) {
        const result = await this.service.maintain(scope, this.options.actor());
        if (result === 'CHECKED') this.options.logger.info({}, 'operations log group checked');
        if (result === 'REQUEUED') {
          this.options.logger.info({}, 'operations log group: preserved reports requeued');
        }
      }
      this.progress.record(this.options.now());
    } catch (error: unknown) {
      this.options.logger.error({ err: error }, 'operations log group pass failed');
    } finally {
      this.running = false;
    }
  }
}
