import { sql, type SQL } from 'drizzle-orm';
import {
  PROVIDER_FAILURE_KINDS,
  type ProviderFailureKind,
  type TenantContext,
} from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { requireTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  EMPTY_FLEET_STATS,
  type PanelFleetStats,
  type PanelFleetStatsReader,
} from '../application/panel-health-dashboard.js';

/** A page of panel ids as bound parameters — never text spliced into the statement. */
function idList(ids: readonly string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
}

/**
 * The per-panel numbers behind the health dashboard, for one page of panels.
 *
 * Three grouped statements for the whole page, never one per panel, and each is
 * served by an index that leads with the tenant:
 *
 *   - services by state: `services_panel_capacity_idx` (`tenant_id, panel_id`,
 *     partial on `state <> 'TERMINATED'`) — the capacity count's own index, and
 *     the same predicate, so "services on this panel" means one thing;
 *   - FAILED operations in the window: `provisioning_operations_failed_recent_idx`
 *     (`tenant_id, completed_at` WHERE FAILED, built online), bounded by the window
 *     rather than by how many operations a tenant has ever run;
 *   - UNKNOWN operations: `provisioning_operations_unknown_idx`, which is partial on
 *     the state and therefore as small as the backlog an operator must reconcile.
 *
 * Tenant-scoped: every statement names the tenant, so a panel id of another tenant
 * contributes nothing.
 */
export class DrizzlePanelFleetStatsReader implements PanelFleetStatsReader {
  constructor(private readonly db: Database) {}

  async statsFor(
    scope: TenantContext,
    panelIds: readonly string[],
    window: { readonly since: Date; readonly until: Date },
  ): Promise<ReadonlyMap<string, PanelFleetStats>> {
    const tenantId = requireTenantId(scope);
    const result = new Map<string, MutableStats>();
    if (panelIds.length === 0) return result;
    const ids = idList(panelIds);
    const entry = (panelId: string): MutableStats => {
      let found = result.get(panelId);
      if (found === undefined) {
        found = {
          services: { ...EMPTY_FLEET_STATS.services },
          provisioning: { ...EMPTY_FLEET_STATS.provisioning },
        };
        result.set(panelId, found);
      }
      return found;
    };

    const services = await this.db.execute<{ panel_id: string; state: string; n: number }>(sql`
      SELECT panel_id, state, count(*)::int AS n
        FROM services
       WHERE tenant_id = ${tenantId}
         AND panel_id IN (${ids})
         AND state <> 'TERMINATED'
       GROUP BY panel_id, state
    `);
    for (const row of services.rows) {
      const counts = entry(row.panel_id).services;
      switch (row.state) {
        case 'ACTIVE':
          counts.active += row.n;
          break;
        case 'SUSPENDED':
          counts.suspended += row.n;
          break;
        case 'EXPIRED':
          counts.expired += row.n;
          break;
        case 'PENDING_PROVISION':
          counts.pending += row.n;
          break;
        case 'UNRECONCILED':
          counts.unreconciled += row.n;
          break;
        default:
          // A state added to the machine is still a service on the panel; it is
          // counted nowhere here rather than under a wrong heading, and the
          // capacity numbers beside it (which derive their set from the contract)
          // still include it.
          break;
      }
    }

    /*
     * Newest failure per panel, with the window's count beside it: DISTINCT ON
     * keeps the newest row, the window function counts the partition before
     * DISTINCT ON discards it. Half-open `[since, until)`.
     */
    const failed = await this.db.execute<{
      panel_id: string;
      n: number;
      completed_at: Date | string;
      failure_kind: string | null;
    }>(sql`
      SELECT DISTINCT ON (panel_id)
             panel_id,
             count(*) OVER (PARTITION BY panel_id)::int AS n,
             completed_at,
             failure_kind
        FROM provisioning_operations
       WHERE tenant_id = ${tenantId}
         AND state = 'FAILED'
         AND completed_at >= ${window.since}
         AND completed_at < ${window.until}
         AND panel_id IN (${ids})
       ORDER BY panel_id, completed_at DESC, id DESC
    `);
    for (const row of failed.rows) {
      const provisioning = entry(row.panel_id).provisioning;
      provisioning.failedInWindow = row.n;
      provisioning.lastFailureAt = new Date(row.completed_at);
      provisioning.lastFailureKind =
        row.failure_kind !== null &&
        (PROVIDER_FAILURE_KINDS as readonly string[]).includes(row.failure_kind)
          ? (row.failure_kind as ProviderFailureKind)
          : null;
    }

    const unknown = await this.db.execute<{ panel_id: string; n: number }>(sql`
      SELECT panel_id, count(*)::int AS n
        FROM provisioning_operations
       WHERE tenant_id = ${tenantId}
         AND state = 'UNKNOWN'
         AND panel_id IN (${ids})
       GROUP BY panel_id
    `);
    for (const row of unknown.rows) entry(row.panel_id).provisioning.unknownOpen = row.n;

    return result;
  }
}

type MutableStats = {
  services: { -readonly [K in keyof PanelFleetStats['services']]: number };
  provisioning: {
    -readonly [K in keyof PanelFleetStats['provisioning']]: PanelFleetStats['provisioning'][K];
  };
};
