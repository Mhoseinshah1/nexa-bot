import { PANEL_HEALTH_FRESH_FOR_MS } from '@nexa/contracts';
import type { ActorContext, MonitorProfile, PermissionKey, ScopeContext } from '@nexa/contracts';
import type { PermissionGuard } from '../../access/application/permission-guard.js';
import type { OperationalConditionReader } from '../../opslog/application/ports.js';
import {
  schedulerFreshPanelUpperBound,
  tenantBudgetFreshPanelUpperBound,
  tenantTurnFreshTenantUpperBound,
} from '../domain/monitor-cadence.js';

export const MONITOR_PROFILE_VIEW: PermissionKey = 'panels.view';

/**
 * The code `PanelMonitorService` opens when the active fleet exceeds what the
 * scheduler can start within one freshness window. Duplicated as a constant
 * rather than imported to keep this read off the monitor's module graph; the
 * integration suite asserts the two agree.
 */
export const SCHEDULER_CAPACITY_CONDITION = 'panel.monitor.scheduler_capacity_exceeded';

/**
 * What the monitor is configured to do, and what that configuration can carry.
 *
 * A READ of installation configuration, with the two capacity ceilings computed
 * here rather than in whatever is asking. Both matter:
 *
 *   - Configuration, because an admin panel that renders a cadence from a
 *     constant in its own bundle is stating a number the deployment may not be
 *     running. The shipped default is three minutes; a deployment can set
 *     anything the schema accepts.
 *   - Computed here, because `tenantBudgetFreshPanelUpperBound` and
 *     `schedulerFreshPanelUpperBound` are the SAME functions the monitor's
 *     capacity conditions use. A second implementation in the browser would be
 *     free to disagree with the one that decides whether an alarm fires, and
 *     the disagreement would show up as a screen saying the fleet fits while
 *     the log says it does not.
 *
 * It does not touch `PanelMonitorService`, the scheduler, or any repository. It
 * reads numbers the composition root already resolved and applies two pure
 * functions to them.
 */
export interface MonitorProfileConfig {
  readonly enabled: boolean;
  readonly tickMs: number;
  readonly healthyIntervalMs: number;
  readonly retryableIntervalMs: number;
  readonly nonRetryableIntervalMs: number;
  readonly batchSize: number;
  readonly concurrency: number;
  readonly tenantsPerTick: number;
  readonly probeTenantLimit: number;
  readonly probeTenantWindowMs: number;
  readonly probeCooldownMs: number;
  readonly budgetReservePercent: number;
}

export class MonitorProfileService {
  constructor(
    private readonly guard: PermissionGuard,
    private readonly config: MonitorProfileConfig,
    private readonly conditions: OperationalConditionReader,
  ) {}

  async read(scope: ScopeContext, actor: ActorContext): Promise<MonitorProfile> {
    // Guarded like every other read. `panels.view` rather than a new key: what
    // this describes is how the panels an operator can already see are looked
    // after, and a permission nobody can be denied is a permission that exists
    // to be looked at rather than enforced.
    await this.guard.check(scope, actor, MONITOR_PROFILE_VIEW);

    const config = this.config;
    // The one condition an operator cannot reach any other way.
    //
    // `panel.monitor.scheduler_capacity_exceeded` is the installation's
    // condition, so the monitor records it under `SYSTEM_SCOPE` with a null
    // tenant — and `DrizzleOperationalEventReader.list` begins with
    // `requireTenantId(scope)`, so `GET /ops-log` can never return it under
    // any scope. It was declared management-facing for a while, which made the
    // alerts page claim to show the one condition the deployment docs call
    // installation-level and un-self-healing, while showing an empty state.
    //
    // This endpoint is installation-scoped by construction — everything else
    // it returns is a fact about the whole deployment — so it is the surface
    // that CAN answer, and answering here needs no change to the tenant
    // isolation the log reader deliberately enforces.
    const schedulerCapacityExceeded = await this.conditions.systemConditionIsOpen(
      SCHEDULER_CAPACITY_CONDITION,
    );

    return {
      ...config,
      schedulerCapacityExceeded,
      freshForMs: PANEL_HEALTH_FRESH_FOR_MS,
      tenantFreshPanelCeiling: tenantBudgetFreshPanelUpperBound(
        config.probeTenantLimit,
        config.probeTenantWindowMs,
        config.healthyIntervalMs,
      ),
      installationFreshPanelCeiling: schedulerFreshPanelUpperBound(
        config.batchSize,
        config.tickMs,
        config.healthyIntervalMs,
      ),
      tenantTurnCeiling: tenantTurnFreshTenantUpperBound(
        config.tenantsPerTick,
        config.tickMs,
        config.healthyIntervalMs,
      ),
    };
  }
}
