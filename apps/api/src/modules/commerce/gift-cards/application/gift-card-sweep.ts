import {
  systemJobActor,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type CorrelationId,
  type IdGenerator,
  type OperationalEventRecorder,
  type PermissionKey,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import { runAuthorizedMutation } from '../../../platform/access/application/authorized-mutation.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { LoopProgress } from '../../../../infrastructure/lifecycle/loop-progress.js';
import { guardedTick } from '../../../../infrastructure/lifecycle/loop-guard.js';
import type { GiftCardSweepRepository } from './ports.js';

/** Hourly: an export's window is a day, so a purge is at most an hour late. */
export const GIFT_CARD_SWEEP_INTERVAL_MS = 3_600_000;
/** After boot, never during startup. */
export const GIFT_CARD_SWEEP_INITIAL_DELAY_MS = 120_000;
/**
 * How long a refused attempt is kept: far past the limiter's one-hour window, so an operator
 * looking into a customer's complaint still finds what was refused and why.
 */
export const GIFT_CARD_ATTEMPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const SWEEP_PERMISSION: PermissionKey = 'maintenance.run';

export interface GiftCardSweepDeps {
  readonly repository: GiftCardSweepRepository;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly guard: PermissionGuard;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly clock: Clock;
}

/**
 * One pass of the gift-card housekeeping (R10 D4), as `SYSTEM_JOB` under `maintenance.run`:
 * the sealed exports whose 24-hour window has passed are purged — both columns set to NULL, so
 * the codes exist only as hashes from then on — and refused attempts past their retention are
 * deleted. Neither moves money or changes a code.
 *
 * Runs whether or not the scope still accepts work: removing a sealed secret is not new work,
 * and keeping plaintext codes longer than promised because an operator stopped the tenant
 * would be the wrong way round.
 */
export async function sweepGiftCards(
  deps: GiftCardSweepDeps,
  scope: TenantContext,
  actor: ActorContext,
): Promise<{ readonly exportsPurged: number; readonly attemptsDeleted: number }> {
  return runAuthorizedMutation(
    deps,
    scope,
    actor,
    SWEEP_PERMISSION,
    { action: 'gift_card.sweep', entityType: 'GiftCardBatch', entityId: null },
    async (tx) => {
      const now = deps.clock.now();
      const exportsPurged = await deps.repository.purgeExpiredExports(scope, now, tx);
      const attemptsDeleted = await deps.repository.deleteAttemptsBefore(
        scope,
        new Date(now.getTime() - GIFT_CARD_ATTEMPT_RETENTION_MS),
        tx,
      );
      return { exportsPurged, attemptsDeleted };
    },
  );
}

/**
 * The worker's hourly gift-card sweep. Its own file for the reason `CustomerReminderLoop`'s
 * docblock gives (`worker-health-coverage.test.ts` marks every class in a file containing
 * `isFresh`). Progress is recorded only when a tick completes, so a sweep whose every pass
 * fails turns the worker's readiness stale.
 */
export class GiftCardSweepLoop {
  private timer: NodeJS.Timeout | null = null;
  private firstRun: NodeJS.Timeout | null = null;
  private running = false;
  private readonly progress: LoopProgress;

  constructor(
    private readonly deps: GiftCardSweepDeps,
    private readonly options: {
      readonly scope: () => TenantContext | null;
      readonly intervalMs: number;
      readonly initialDelayMs: number;
      readonly ids: Pick<IdGenerator, 'uuid'>;
      readonly logger: {
        info: (context: Record<string, unknown>, message: string) => void;
        warn: (context: Record<string, unknown>, message: string) => void;
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
    this.progress.begin(this.deps.clock.now().getTime());
    const tick = guardedTick('gift-card-sweep', () => this.tick(), this.options.logger);
    this.firstRun = setTimeout(tick, this.options.initialDelayMs);
    this.timer = setInterval(tick, this.options.intervalMs);
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

  /** One tick. Public so a test drives exactly one; overlapping calls do nothing. */
  async tick(): Promise<{
    readonly exportsPurged: number;
    readonly attemptsDeleted: number;
  } | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const scope = this.options.scope();
      if (scope === null) {
        this.progress.record(this.deps.clock.now().getTime());
        return { exportsPurged: 0, attemptsDeleted: 0 };
      }
      const actor = systemJobActor('gift-card-sweep', this.options.ids.uuid() as CorrelationId);
      let result: { readonly exportsPurged: number; readonly attemptsDeleted: number };
      try {
        result = await sweepGiftCards(this.deps, scope, actor);
      } catch (error: unknown) {
        this.options.logger.error({ error }, 'gift card sweep failed');
        return null;
      }
      this.progress.record(this.deps.clock.now().getTime());
      if (result.exportsPurged + result.attemptsDeleted > 0) {
        this.options.logger.info(result, 'gift card exports purged and attempts deleted');
      }
      return result;
    } finally {
      this.running = false;
    }
  }
}
