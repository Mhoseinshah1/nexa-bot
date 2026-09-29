import {
  CAMPAIGN_SCHEDULE_BATCH,
  systemJobActor,
  type CorrelationId,
  type IdGenerator,
  type TenantContext,
} from '@nexa/contracts';
import { LoopProgress } from '../../../../infrastructure/lifecycle/loop-progress.js';
import type { CampaignRepository } from './ports.js';
import type { CampaignService } from './campaign.service.js';

/**
 * The campaign lane (`docs/round-n-campaigns-audit.md` D11), in the WORKER.
 *
 * Each tick moves every campaign whose start has passed SCHEDULED → ACTIVE, then every
 * campaign whose end has passed to COMPLETED — each one its own short transaction, each a
 * conditional UPDATE naming its from-state and its time. Two replicas running the same
 * tick on a rolling update is the ordinary case: the UPDATE decides which one moved a
 * campaign, and the other's is a no-op that launches nothing.
 *
 * Nothing financial depends on this lane's punctuality. A campaign's discount and cashback
 * rules carry the campaign's own window, which the pricing engine enforces, so a late or
 * stopped worker delays the campaign's STATUS, never the start or end of its prices.
 *
 * Its own file for the reason `CustomerReminderLoop`'s docblock gives
 * (`worker-health-coverage.test.ts` marks every class in a file containing `isFresh`).
 * Progress is recorded only when a tick completes, so a lane whose every pass fails turns
 * the worker's readiness stale instead of failing in silence.
 */
export class CampaignScheduleLoop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly progress: LoopProgress;

  constructor(
    private readonly service: Pick<CampaignService, 'startIfDue' | 'completeIfDue'>,
    private readonly campaigns: Pick<CampaignRepository, 'dueToStart' | 'dueToComplete'>,
    private readonly options: {
      readonly scope: () => TenantContext | null;
      readonly intervalMs: number;
      readonly now: () => Date;
      readonly ids: Pick<IdGenerator, 'uuid'>;
      readonly logger: {
        info: (context: Record<string, unknown>, message: string) => void;
        error: (context: Record<string, unknown>, message: string) => void;
      };
    },
  ) {
    this.progress = new LoopProgress(options.intervalMs);
  }

  /** Whether a tick has completed recently enough. See `LoopProgress`. */
  isFresh(nowMs: number): boolean {
    return this.progress.isFresh(nowMs);
  }

  start(): void {
    if (this.timer !== null) return;
    this.progress.begin(this.options.now().getTime());
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
    this.timer.unref?.();
  }

  /** Stops the timer and waits for a tick already inside a transaction. */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 10));
    this.progress.end();
  }

  /** One tick. Public so a test drives exactly one, and two at once. */
  async tick(): Promise<{ started: number; completed: number }> {
    if (this.running) return { started: 0, completed: 0 };
    this.running = true;
    try {
      const scope = this.options.scope();
      if (scope === null) {
        this.progress.record(this.options.now().getTime());
        return { started: 0, completed: 0 };
      }
      const result = await this.runOnce(scope);
      this.progress.record(this.options.now().getTime());
      if (result.started + result.completed > 0) {
        this.options.logger.info(result, 'campaigns moved');
      }
      return result;
    } catch (error: unknown) {
      this.options.logger.error({ error }, 'campaign schedule tick failed');
      return { started: 0, completed: 0 };
    } finally {
      this.running = false;
    }
  }

  /** One pass over one tenant, without the loop's own re-entrancy guard. */
  async runOnce(scope: TenantContext): Promise<{ started: number; completed: number }> {
    const actor = systemJobActor('campaign-schedule', this.options.ids.uuid() as CorrelationId);
    let started = 0;
    let completed = 0;
    const now = this.options.now();
    for (const id of await this.campaigns.dueToStart(scope, now, CAMPAIGN_SCHEDULE_BATCH)) {
      if (await this.service.startIfDue(scope, actor, id)) started += 1;
    }
    for (const id of await this.campaigns.dueToComplete(scope, now, CAMPAIGN_SCHEDULE_BATCH)) {
      if (await this.service.completeIfDue(scope, actor, id)) completed += 1;
    }
    return { started, completed };
  }
}
