import {
  DASHBOARD_EXPIRING_WITHIN_DAYS,
  DASHBOARD_OPERATION_PERMISSIONS,
  NAV_COUNTER_KEYS,
  NAV_COUNTER_PERMISSIONS,
  PANEL_HEALTH_VIEWS,
  providerDescriptor,
  type ActorContext,
  type Clock,
  type DashboardOperationsResponse,
  type NavCounterKey,
  type NavCountersResponse,
  type PanelHealthState,
  type PanelHealthView,
  type PanelStatus,
  type PermissionKey,
  type TenantContext,
} from '@nexa/contracts';
import { healthViewOf } from '../../../platform/panels/application/panel-health-view.js';

/**
 * The dashboard's operational gauges and the sidebar's counters (round W,
 * `docs/web-redesign/dashboard.md`).
 *
 * Read-only, and not the business gate: each section is what the page it summarises already
 * shows to whoever may open that page, so each is computed ONLY when the viewer holds that
 * page's permission and is otherwise `null`. The decision is the guard's own resolution rule
 * (`permissionsOf`), read once per request.
 *
 * Why a withheld section rather than a 403. The sidebar asks on every page, every minute, for
 * six counts whatever the viewer's role is; charging each through `check` would record an
 * `access.permission_denied` event per missing permission per poll — the unbounded write into
 * the alerts feed that `polling.ts` exists to prevent. Nothing is disclosed by the omission:
 * the viewer's own permission list is already theirs (`GET /auth/session`), and a withheld
 * section is not computed at all, so its query never runs.
 */

export interface PanelFleetRow {
  readonly status: PanelStatus;
  /** The latest probe's stored state, or null where no probe has run. */
  readonly health: PanelHealthState | null;
  readonly providerType: string;
  readonly count: number;
}

export interface OperationsOverviewRepository {
  /** Every panel that is not ARCHIVED, grouped by status, stored health and provider. */
  panelFleet(scope: TenantContext): Promise<readonly PanelFleetRow[]>;
  provisioningQueue(
    scope: TenantContext,
  ): Promise<{ readonly queued: number; readonly unknown: number }>;
  unreconciledServices(scope: TenantContext, cap: number): Promise<number>;
  expiringServices(scope: TenantContext, now: Date, withinDays: number): Promise<number>;
  /** One sidebar counter, bounded: at most `cap`. */
  navCounter(scope: TenantContext, key: NavCounterKey, cap: number): Promise<number>;
}

export interface PermissionReader {
  permissionsOf(scope: TenantContext, actor: ActorContext): Promise<ReadonlySet<PermissionKey>>;
}

export interface OperationsOverviewDeps {
  readonly permissions: PermissionReader;
  readonly repository: OperationsOverviewRepository;
  readonly clock: Clock;
  readonly counterCap: number;
}

export class OperationsOverviewService {
  constructor(private readonly deps: OperationsOverviewDeps) {}

  async operations(
    scope: TenantContext,
    actor: ActorContext,
  ): Promise<DashboardOperationsResponse> {
    const held = await this.deps.permissions.permissionsOf(scope, actor);
    const may = (section: keyof typeof DASHBOARD_OPERATION_PERMISSIONS): boolean =>
      held.has(DASHBOARD_OPERATION_PERMISSIONS[section]);
    const repo = this.deps.repository;
    const now = this.deps.clock.now();
    return {
      generatedAt: now.toISOString(),
      panels: may('panels') ? fleetOf(await repo.panelFleet(scope)) : null,
      provisioning: may('provisioning')
        ? {
            ...(await repo.provisioningQueue(scope)),
            unreconciledServices: await repo.unreconciledServices(scope, this.deps.counterCap),
          }
        : null,
      expiring: may('expiring')
        ? {
            withinDays: DASHBOARD_EXPIRING_WITHIN_DAYS,
            count: await repo.expiringServices(scope, now, DASHBOARD_EXPIRING_WITHIN_DAYS),
          }
        : null,
    };
  }

  async navCounters(scope: TenantContext, actor: ActorContext): Promise<NavCountersResponse> {
    const held = await this.deps.permissions.permissionsOf(scope, actor);
    const counters = {} as Record<NavCounterKey, number | null>;
    for (const key of NAV_COUNTER_KEYS) {
      counters[key] = held.has(NAV_COUNTER_PERMISSIONS[key])
        ? await this.deps.repository.navCounter(scope, key, this.deps.counterCap)
        : null;
    }
    return { generatedAt: this.deps.clock.now().toISOString(), counters };
  }
}

/**
 * The fleet from its grouped rows: totals, the health VIEW through the panels module's own
 * projection, and the provider's canonical name from the descriptor catalogue — exactly what
 * the panel list shows for each panel, counted once.
 */
export function fleetOf(
  rows: readonly PanelFleetRow[],
): NonNullable<DashboardOperationsResponse['panels']> {
  const health = new Map<PanelHealthView, number>();
  const providers = new Map<string, number>();
  let total = 0;
  let active = 0;
  for (const row of rows) {
    total += row.count;
    if (row.status === 'ACTIVE') active += row.count;
    const view = healthViewOf(row.status, row.health);
    health.set(view, (health.get(view) ?? 0) + row.count);
    providers.set(row.providerType, (providers.get(row.providerType) ?? 0) + row.count);
  }
  return {
    total,
    active,
    health: PANEL_HEALTH_VIEWS.filter((state) => health.has(state)).map((state) => ({
      state,
      count: health.get(state) ?? 0,
    })),
    providers: [...providers.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([providerType, count]) => ({
        providerType,
        providerName: providerDescriptor(providerType)?.canonicalName ?? providerType,
        count,
      })),
  };
}
