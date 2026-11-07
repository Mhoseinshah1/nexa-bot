import {
  AUTO_DELETE_PREVIEW_WINDOW_HOURS,
  SERVICE_AUTO_DELETE_FEATURE,
  SERVICE_AUTO_DELETE_SETTING_KEYS,
  SERVICE_TERMINATE_REASON_AUTO_DELETE,
  type ActorContext,
  type Clock,
  type CorrelationId,
  type FeatureFlagKey,
  type IdGenerator,
  type PermissionKey,
  type ScopeContext,
  type ServiceAutoDeletePreviewQuery,
  type ServiceAutoDeletePreviewResponse,
  type TemplateValues,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { CustomerNotifier } from '../../messaging/application/customer-notifier.js';
import type { ServiceRepository } from './ports.js';
import type { ProvisioningService } from './provisioning.service.js';
import type {
  AutoDeleteDays,
  AutoDeleteRepository,
  AutoDeleteRun,
} from './service-auto-delete.ports.js';

/**
 * What the sweep acts under: `maintenance.run`, the one key `SYSTEM_JOB_PERMISSIONS` grants
 * (the automatic renewal's). The check is still MADE, because `docs/conventions.md` forbids
 * exempting an actor type; jobs hold no `services.terminate`, and are not given it here.
 */
const AUTO_DELETE_PERMISSION: PermissionKey = 'maintenance.run';
/** The preview is a read of settings and services: `settings.view`. */
const AUTO_DELETE_PREVIEW_PERMISSION: PermissionKey = 'settings.view';

/** At most this many cycles scheduled (and warned) per tenant per pass. */
export const AUTO_DELETE_SCHEDULE_LIMIT = 200;
/** At most this many unknown clocks stamped per tenant per pass. */
export const AUTO_DELETE_STAMP_LIMIT = 1000;
/** The rate limit's window: `max_per_minute` deletions planned per panel per this long. */
export const AUTO_DELETE_RATE_WINDOW_MS = 60_000;

const HOUR_MS = 3_600_000;

/** The worker's actor: a `SYSTEM_JOB` on the `SCHEDULER` surface. */
export function autoDeleteActor(runId: string | null): ActorContext {
  return {
    type: 'SYSTEM_JOB',
    id: 'auto-delete',
    label: 'job:auto-delete',
    surface: 'SCHEDULER',
    correlationId: `auto-delete:${runId ?? 'pass'}` as CorrelationId,
  };
}

/** The idempotency key of one cycle's TERMINATE: derived from the cycle's own run row. */
export function autoDeleteIdempotencyKey(runId: string): string {
  return `auto-delete:${runId}`;
}

/** When a cycle may be deleted: its due moment, and never sooner than its warning allows. */
export function autoDeleteAfter(dueAt: Date, now: Date, warnHours: number): Date {
  return new Date(Math.max(dueAt.getTime(), now.getTime() + warnHours * HOUR_MS));
}

export interface AutoDeleteConfig {
  readonly days: AutoDeleteDays;
  readonly warnHours: number;
  readonly maxPerMinute: number;
}

export interface AutoDeleteReport {
  readonly stamped: number;
  readonly scheduled: number;
  readonly warned: number;
  readonly planned: number;
  /** Due cycles held back this pass by the per-panel rate limit. */
  readonly deferred: number;
}

const EMPTY: AutoDeleteReport = { stamped: 0, scheduled: 0, warned: 0, planned: 0, deferred: 0 };

export interface ServiceAutoDeleteDeps {
  readonly repository: AutoDeleteRepository;
  readonly services: Pick<ServiceRepository, 'lockForUpdate' | 'lockLifecycle'>;
  readonly provisioning: Pick<ProvisioningService, 'planAutoDeleteWithin'>;
  /** Readers, not services, for the reason `ServiceReminderService` gives. */
  readonly features: {
    isEnabled(scope: ScopeContext, key: FeatureFlagKey, tx?: unknown): Promise<boolean>;
  };
  readonly settings: {
    valueOf<T>(scope: ScopeContext, key: string, tx?: unknown): Promise<T>;
  };
  readonly notifier: Pick<CustomerNotifier, 'notify'>;
  readonly guard: PermissionGuard;
  readonly outbox: OutboxWriter;
  readonly scopeActivity: ScopeActivityReader;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger?: {
    error: (context: Record<string, unknown>, message: string) => void;
  };
}

/**
 * NEXA-OWNER-BATCH-1 PR-3 — «حذف خودکار سرویس» (Mirza «کرون حذف»).
 *
 * One pass over one tenant, run by the worker's per-tenant fan-out (`TenantFanOut`) under that
 * tenant's RLS binding, every minute:
 *
 * 1. **Clocks.** An EXPIRED or SUSPENDED service whose clock is unknown (`state_since` NULL: it
 *    predates the column, or an import wrote it) is stamped with NOW — the moment this
 *    installation first saw it so — and never with a guessed earlier moment. This happens
 *    whether or not the flag is on, so the clock of an imported backlog starts running at the
 *    deploy and the preview means something before the switch-on. It sends and deletes nothing.
 * 2. **Schedule and warn** (flag on). A service whose cycle is due within the warning's lead
 *    gets its cycle's run row (unique per service and `state_since`) and, in the same
 *    transaction, its ONE warning through the notification lane, and the cycle's outbox event.
 *    Its `delete_after` is its due moment and never sooner than `warn_hours` after the warning.
 * 3. **Delete** (flag on). A scheduled cycle past `delete_after` is planned as the provisioning
 *    `TERMINATE` the Web Admin's «پایان سرویس» plans (`planAutoDeleteWithin`), one service per
 *    transaction, at most `max_per_minute` per panel per minute. Inside that transaction, under
 *    the service's row lock, it re-reads the scope's activity, the flag, the cycle (renewed or
 *    resumed since the warning? then nothing) and what blocks it (an open order, an undecided
 *    payment, an open operation or refund request). The run goes `PLANNED` with the
 *    operation, conditionally, in the same transaction: a cycle is planned exactly once, and
 *    the provisioner's own claim, backoff and failure path carry it from there — a TERMINATE
 *    that fails is never planned again.
 *
 * A stopped tenant, or the flag off, is a pass that did nothing — not a failure.
 */
export class ServiceAutoDeleteService {
  constructor(private readonly deps: ServiceAutoDeleteDeps) {}

  async featureOn(scope: TenantContext, tx?: unknown): Promise<boolean> {
    return this.deps.features.isEnabled(scope, SERVICE_AUTO_DELETE_FEATURE, tx);
  }

  async config(scope: TenantContext, tx?: unknown): Promise<AutoDeleteConfig> {
    const value = (key: string): Promise<number> =>
      this.deps.settings.valueOf<number>(scope, key, tx);
    const keys = SERVICE_AUTO_DELETE_SETTING_KEYS;
    return {
      days: {
        traffic: await value(keys.afterTrafficDays),
        time: await value(keys.afterTimeDays),
        suspended: await value(keys.afterSuspendDays),
      },
      warnHours: await value(keys.warnHours),
      maxPerMinute: await value(keys.maxPerMinute),
    };
  }

  async runOnce(scope: TenantContext): Promise<AutoDeleteReport> {
    await this.deps.guard.check(scope, autoDeleteActor(null), AUTO_DELETE_PERMISSION);
    const first = await this.schedulePass(scope);
    if (first.config === null) return { ...EMPTY, stamped: first.stamped };
    const deleted = await this.deletePass(scope, first.config);
    return {
      stamped: first.stamped,
      scheduled: first.scheduled,
      warned: first.warned,
      planned: deleted.planned,
      deferred: deleted.deferred,
    };
  }

  /** Steps 1 and 2, in one transaction. `config` is null when nothing more is to be done. */
  private async schedulePass(scope: TenantContext): Promise<{
    readonly stamped: number;
    readonly scheduled: number;
    readonly warned: number;
    readonly config: AutoDeleteConfig | null;
  }> {
    const now = this.deps.clock.now();
    return this.deps.uow.run(scope, async (tx) => {
      const none = { stamped: 0, scheduled: 0, warned: 0, config: null };
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return none;
      const stamped = await this.deps.repository.stampUnknownClocks(
        scope,
        now,
        AUTO_DELETE_STAMP_LIMIT,
        tx,
      );
      if (!(await this.featureOn(scope, tx))) return { ...none, stamped };
      const config = await this.config(scope, tx);
      const { days } = config;
      if (days.traffic <= 0 && days.time <= 0 && days.suspended <= 0) {
        return { ...none, stamped };
      }
      const horizon = new Date(now.getTime() + config.warnHours * HOUR_MS);
      const candidates = await this.deps.repository.listToSchedule(
        scope,
        { horizon, days },
        AUTO_DELETE_SCHEDULE_LIMIT,
        tx,
      );
      let scheduled = 0;
      let warned = 0;
      for (const candidate of candidates) {
        const warn = config.warnHours > 0;
        const run = await this.deps.repository.schedule(
          scope,
          {
            id: this.deps.ids.uuid(),
            candidate,
            deleteAfter: autoDeleteAfter(candidate.dueAt, now, config.warnHours),
            warnedAt: warn ? now : null,
            now,
          },
          tx,
        );
        if (run === null) continue;
        scheduled += 1;
        await this.deps.outbox.write(tx, autoDeleteActor(run.id), {
          eventType: 'ServiceAutoDeleteScheduled',
          aggregateType: 'Service',
          aggregateId: run.serviceId,
          payload: {
            serviceId: run.serviceId,
            customerId: run.customerId,
            runId: run.id,
            cause: run.cause,
            days: run.days,
            warned: warn,
            deleteAfter: run.deleteAfter.toISOString(),
          },
        });
        if (warn) {
          // One warning per cycle: the run row's unique insert above is what says so.
          await this.deps.notifier.notify(
            scope,
            run.customerId,
            'SERVICE_AUTO_DELETE_WARNING',
            run.id,
            now,
            tx,
          );
          warned += 1;
        }
      }
      return { stamped, scheduled, warned, config };
    });
  }

  /** Step 3: each panel's due cycles, at most `max_per_minute` planned per minute. */
  private async deletePass(
    scope: TenantContext,
    config: AutoDeleteConfig,
  ): Promise<{ readonly planned: number; readonly deferred: number }> {
    const now = this.deps.clock.now();
    const due = await this.deps.uow.run(scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return [];
      if (!(await this.featureOn(scope, tx))) return [];
      const panels = await this.deps.repository.deletablePanels(
        scope,
        { now, days: config.days },
        tx,
      );
      const runs: AutoDeleteRun[] = [];
      for (const panelId of panels) {
        const since = new Date(now.getTime() - AUTO_DELETE_RATE_WINDOW_MS);
        const used = await this.deps.repository.plannedOnPanelSince(scope, panelId, since, tx);
        const room = Math.max(0, config.maxPerMinute - used);
        if (room === 0) continue;
        runs.push(
          ...(await this.deps.repository.listDeletable(
            scope,
            { now, days: config.days, panelId },
            room,
            tx,
          )),
        );
      }
      return runs;
    });
    let planned = 0;
    let deferred = 0;
    for (const run of due) {
      try {
        const outcome = await this.plan(scope, run, config);
        if (outcome === 'PLANNED') planned += 1;
        else if (outcome === 'RATE_LIMITED') deferred += 1;
      } catch (error: unknown) {
        // A refusal (the panel cannot terminate now, a refund request opened): nothing was
        // written; the cycle stays SCHEDULED and a later pass judges it again.
        this.deps.logger?.error({ error, runId: run.id }, 'automatic deletion not planned');
      }
    }
    return { planned, deferred };
  }

  /** One cycle's TERMINATE, planned exactly once, in its own transaction. */
  private async plan(
    scope: TenantContext,
    run: AutoDeleteRun,
    config: AutoDeleteConfig,
  ): Promise<'PLANNED' | 'SKIPPED' | 'BLOCKED' | 'RATE_LIMITED'> {
    const actor = autoDeleteActor(run.id);
    return this.deps.uow.run(scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return 'SKIPPED';
      if (!(await this.featureOn(scope, tx))) return 'SKIPPED';
      // The row lock FIRST: a renewal that commits after this waits, and one that committed
      // before is seen by the re-reads below.
      const service = await this.deps.services.lockForUpdate(scope, run.serviceId, tx);
      if (service === null) return 'SKIPPED';
      /*
       * Then the lifecycle lock, BEFORE the blockers are read (Codex review of #422), and held
       * through the plan. A paid renewal's settlement serialises on this lock alone, not on the
       * row (`prepareCommercialAction`): read before it, a renewal committing between the read
       * and the plan would be deleted the moment it was paid for. The plan takes it again,
       * which is a no-op; taken in the order every TERMINATE planner takes it (row, then this).
       */
      await this.deps.services.lockLifecycle(scope, service.id, tx);
      // Still the cycle that was warned: same state, same moment, still SCHEDULED.
      if (!(await this.deps.repository.stillDeletable(scope, run.id, tx))) return 'SKIPPED';
      if (await this.deps.repository.isBlocked(scope, service.id, tx)) return 'BLOCKED';
      // The per-panel rate limit, serialised per panel so two replicas cannot both take the
      // last slot of the minute.
      await this.deps.repository.lockPanelRate(scope, run.panelId, tx);
      const now = this.deps.clock.now();
      const since = new Date(now.getTime() - AUTO_DELETE_RATE_WINDOW_MS);
      const used = await this.deps.repository.plannedOnPanelSince(scope, run.panelId, since, tx);
      if (used >= config.maxPerMinute) return 'RATE_LIMITED';
      const operation = await this.deps.provisioning.planAutoDeleteWithin(
        scope,
        actor,
        service,
        { idempotencyKey: autoDeleteIdempotencyKey(run.id) },
        tx,
      );
      const moved = await this.deps.repository.markPlanned(
        scope,
        { runId: run.id, operationId: operation.id, now },
        tx,
      );
      if (!moved) return 'SKIPPED';
      await this.deps.outbox.write(tx, actor, {
        eventType: 'ServiceAutoDeletePlanned',
        aggregateType: 'Service',
        aggregateId: run.serviceId,
        payload: {
          serviceId: run.serviceId,
          customerId: run.customerId,
          runId: run.id,
          cause: run.cause,
          days: run.days,
          operationId: operation.id,
          reason: SERVICE_TERMINATE_REASON_AUTO_DELETE,
        },
      });
      return 'PLANNED';
    });
  }

  // --- the warning -----------------------------------------------------------------------

  /** What the warning renders, read at send time from the run's own snapshot (ADR 0030 §1). */
  async noticeFacts(
    scope: TenantContext,
    runId: string,
  ): Promise<{ readonly values: TemplateValues; readonly serviceId: string } | null> {
    const facts = await this.deps.repository.noticeFacts(scope, runId);
    if (facts === null) return null;
    return {
      values: { service: facts.serviceLabel, deleteAt: facts.deleteAfter },
      serviceId: facts.serviceId,
    };
  }

  // --- the Web Admin's preview -----------------------------------------------------------

  /**
   * «با این تنظیمات، N سرویس در ۲۴ ساعت آینده حذف می‌شود», per cause: the services that would
   * become deletable within the next day with the settings being edited (each one absent is the
   * stored setting). A read; whether the flag is on or not.
   */
  async preview(
    scope: TenantContext,
    actor: ActorContext,
    query: ServiceAutoDeletePreviewQuery,
  ): Promise<ServiceAutoDeletePreviewResponse> {
    await this.deps.guard.check(scope, actor, AUTO_DELETE_PREVIEW_PERMISSION);
    const stored = await this.config(scope);
    const now = this.deps.clock.now();
    const counts = await this.deps.repository.preview(scope, {
      now,
      windowEnd: new Date(now.getTime() + AUTO_DELETE_PREVIEW_WINDOW_HOURS * HOUR_MS),
      days: {
        traffic: query.afterTrafficDays ?? stored.days.traffic,
        time: query.afterTimeDays ?? stored.days.time,
        suspended: query.afterSuspendDays ?? stored.days.suspended,
      },
      warnHours: query.warnHours ?? stored.warnHours,
    });
    return {
      windowHours: AUTO_DELETE_PREVIEW_WINDOW_HOURS,
      traffic: counts.traffic,
      time: counts.time,
      suspended: counts.suspended,
      total: counts.traffic + counts.time + counts.suspended,
      enabled: await this.featureOn(scope),
    };
  }
}
