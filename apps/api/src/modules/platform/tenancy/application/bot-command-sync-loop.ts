import { LoopProgress } from '../../../../infrastructure/lifecycle/loop-progress.js';
import {
  BOT_COMMAND_SYNC_INTERVAL_MS,
  BOT_COMMAND_SYNC_RECONCILE_INTERVAL_MS,
} from '../domain/bot-command-sync.js';
import type { BotCommandSyncService, CommandSyncTickResult } from './bot-command-sync.service.js';

/**
 * The command-sync lane's timer, in the WORKER (round P).
 *
 * Each tick claims the due rows across tenants and attempts each in isolation; every
 * `reconcileIntervalMs` it also sweeps every ACTIVE bot for a menu that differs from what
 * Telegram was last given and queues it — the path that covers a release which changed
 * `BOT_COMMANDS` on an installation the installer's reconcile did not reach. Two replicas
 * on a rolling update is the ordinary case: the claim is a lease taken by conditional
 * UPDATE, so neither sees the other's rows.
 *
 * Its own file for the reason `CampaignScheduleLoop`'s docblock gives
 * (`worker-health-coverage.test.ts` marks every class in a file containing `isFresh`).
 * Progress is recorded only when a tick completes.
 */
export class BotCommandSyncLoop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastReconcileAt: number | null = null;
  private readonly progress: LoopProgress;

  constructor(
    private readonly service: Pick<BotCommandSyncService, 'tick' | 'reconcile'>,
    private readonly options: {
      readonly now: () => Date;
      readonly intervalMs?: number;
      readonly reconcileIntervalMs?: number;
      readonly logger: {
        info: (context: Record<string, unknown>, message: string) => void;
        error: (context: Record<string, unknown>, message: string) => void;
      };
    },
  ) {
    this.progress = new LoopProgress(options.intervalMs ?? BOT_COMMAND_SYNC_INTERVAL_MS);
  }

  isFresh(nowMs: number): boolean {
    return this.progress.isFresh(nowMs);
  }

  start(): void {
    if (this.timer !== null) return;
    this.progress.begin(this.options.now().getTime());
    this.timer = setInterval(
      () => void this.tick(),
      this.options.intervalMs ?? BOT_COMMAND_SYNC_INTERVAL_MS,
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

  /** One tick. Public so a test drives exactly one. */
  async tick(): Promise<CommandSyncTickResult & { readonly reconciled: number }> {
    const idle = { claimed: 0, synced: 0, failed: 0, released: 0, reconciled: 0 };
    if (this.running) return idle;
    this.running = true;
    try {
      const now = this.options.now();
      const every = this.options.reconcileIntervalMs ?? BOT_COMMAND_SYNC_RECONCILE_INTERVAL_MS;
      let reconciled = 0;
      if (this.lastReconcileAt === null || now.getTime() - this.lastReconcileAt >= every) {
        reconciled = await this.service.reconcile();
        this.lastReconcileAt = now.getTime();
      }
      const result = await this.service.tick(now);
      this.progress.record(this.options.now().getTime());
      if (result.claimed > 0 || reconciled > 0) {
        this.options.logger.info({ ...result, reconciled }, 'command menus synced');
      }
      return { ...result, reconciled };
    } catch (error: unknown) {
      this.options.logger.error({ err: String(error) }, 'command sync tick failed');
      return idle;
    } finally {
      this.running = false;
    }
  }
}
