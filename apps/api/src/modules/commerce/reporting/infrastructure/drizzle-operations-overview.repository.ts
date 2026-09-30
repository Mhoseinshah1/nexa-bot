import { sql, type SQL } from 'drizzle-orm';
import {
  AUDIENCE_DEFINITION_VERSION,
  DASHBOARD_QUEUED_OPERATION_STATES,
  MANAGEMENT_CONDITION_FAILURE_CODES,
  NAV_ATTENTION_PANEL_HEALTH_STATES,
  SERVICE_REFUND_REQUEST_ATTENTION_STATES,
  TICKET_AWAITING_SUPPORT_STATUSES,
  audienceDefinitionSchema,
  type NavCounterKey,
  type PanelHealthState,
  type PanelStatus,
  type TenantContext,
} from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { audienceServicePredicate } from '../../audience/infrastructure/audience-sql.js';
import type {
  OperationsOverviewRepository,
  PanelFleetRow,
} from '../application/operations-overview.service.js';

const HOURS_PER_DAY = 24;

/**
 * The dashboard's operational counts and the sidebar's (`docs/web-redesign/dashboard.md`).
 *
 * Every statement is bounded by the tenant first and answers ONE count from an index that
 * already exists; each is the predicate the page it links to already filters by, stated once:
 *
 *   panels                  `panels_tenant_status_idx`, a LEFT JOIN on `panel_health`'s key
 *   provisioning_operations `provisioning_operations_open_*` / `_unknown_idx` (partial)
 *   services                `services_unreconciled_idx`, `services_expiry_idx` (partial)
 *   operational_events      `operational_events_code_idx`
 *   tickets                 `tickets_tenant_status_idx`
 *   service_refund_requests the tenant filter; the attention set is small by construction
 *   payments                `payments_unknown_idx` / `payments_tenant_state_idx`
 *
 * A sidebar counter reads at most `cap` rows (`LIMIT` inside the count), so a backlog of a
 * million costs what a backlog of a thousand does, and the answer says "this many or more".
 */
export class DrizzleOperationsOverviewRepository implements OperationsOverviewRepository {
  constructor(private readonly db: Database) {}

  private async rows<T>(query: SQL): Promise<T[]> {
    const result = await this.db.execute<T & Record<string, unknown>>(query);
    return result.rows as T[];
  }

  private async count(query: SQL): Promise<number> {
    const [row] = await this.rows<{ n: number }>(query);
    return row?.n ?? 0;
  }

  async panelFleet(scope: TenantContext): Promise<readonly PanelFleetRow[]> {
    const rows = await this.rows<{
      status: PanelStatus;
      health: PanelHealthState | null;
      provider_type: string;
      n: number;
    }>(sql`
      SELECT p.status, h.state AS health, p.provider_type, count(*)::int AS n
        FROM panels p
        LEFT JOIN panel_health h ON h.tenant_id = p.tenant_id AND h.panel_id = p.id
       WHERE p.tenant_id = ${tenant(scope)} AND p.status <> 'ARCHIVED'
       GROUP BY 1, 2, 3`);
    return rows.map((row) => ({
      status: row.status,
      health: row.health,
      providerType: row.provider_type,
      count: row.n,
    }));
  }

  async provisioningQueue(scope: TenantContext): Promise<{ queued: number; unknown: number }> {
    const [row] = await this.rows<{ queued: number; unknown: number }>(sql`
      SELECT count(*) FILTER (WHERE op.state = ANY(${text(DASHBOARD_QUEUED_OPERATION_STATES)}))::int AS queued,
             count(*) FILTER (WHERE op.state = 'UNKNOWN')::int AS unknown
        FROM provisioning_operations op
       WHERE op.tenant_id = ${tenant(scope)}
         AND op.state = ANY(${text([...DASHBOARD_QUEUED_OPERATION_STATES, 'UNKNOWN'])})`);
    return { queued: row?.queued ?? 0, unknown: row?.unknown ?? 0 };
  }

  async unreconciledServices(scope: TenantContext, cap: number): Promise<number> {
    return this.count(
      capped(
        sql`SELECT 1 FROM services s WHERE s.tenant_id = ${tenant(scope)} AND s.state = 'UNRECONCILED'`,
        cap,
      ),
    );
  }

  /**
   * THE audience predicate for "expiring within N hours" — an ACTIVE service with an expiry
   * in `[now, now + N h)` — so the dashboard's number is the number a broadcast to "services
   * expiring this week" would reach, never a second reading of "expiring".
   */
  async expiringServices(scope: TenantContext, now: Date, withinDays: number): Promise<number> {
    const definition = audienceDefinitionSchema.parse({
      version: AUDIENCE_DEFINITION_VERSION,
      service: { expiringWithinHours: withinDays * HOURS_PER_DAY },
    });
    const predicate = audienceServicePredicate(
      { tenantId: scope.tenantId, definition, asOf: now },
      sql`s`,
    );
    return this.count(sql`
      SELECT count(*)::int AS n FROM services s
       WHERE s.tenant_id = ${tenant(scope)} AND ${predicate}`);
  }

  async navCounter(scope: TenantContext, key: NavCounterKey, cap: number): Promise<number> {
    const t = tenant(scope);
    switch (key) {
      case 'openConditions':
        // The dashboard's "needs attention" card: MANAGEMENT_CONDITIONS, open.
        return this.count(
          capped(
            sql`SELECT 1 FROM operational_events e
               WHERE e.tenant_id = ${t}
                 AND e.code = ANY(${text(MANAGEMENT_CONDITION_FAILURE_CODES)})
                 AND e.resolved_at IS NULL`,
            cap,
          ),
        );
      case 'ticketsAwaitingSupport':
        return this.count(
          capped(
            sql`SELECT 1 FROM tickets k
               WHERE k.tenant_id = ${t} AND k.status = ANY(${text(TICKET_AWAITING_SUPPORT_STATUSES)})`,
            cap,
          ),
        );
      case 'unhealthyPanels':
        return this.count(
          capped(
            sql`SELECT 1 FROM panels p
                JOIN panel_health h ON h.tenant_id = p.tenant_id AND h.panel_id = p.id
               WHERE p.tenant_id = ${t} AND p.status = 'ACTIVE'
                 AND h.state = ANY(${text(NAV_ATTENTION_PANEL_HEALTH_STATES)})`,
            cap,
          ),
        );
      case 'unreconciledServices':
        return this.unreconciledServices(scope, cap);
      case 'refundRequestsAwaiting':
        return this.count(
          capped(
            sql`SELECT 1 FROM service_refund_requests q
               WHERE q.tenant_id = ${t} AND q.state = ANY(${text(SERVICE_REFUND_REQUEST_ATTENTION_STATES)})`,
            cap,
          ),
        );
      case 'paymentsUnknown':
        return this.count(
          capped(
            sql`SELECT 1 FROM payments p WHERE p.tenant_id = ${t} AND p.state = 'UNKNOWN'`,
            cap,
          ),
        );
      default: {
        const unreachable: never = key;
        throw new Error(`unknown counter ${String(unreachable)}`);
      }
    }
  }
}

function tenant(scope: TenantContext): SQL {
  return sql`${scope.tenantId}::uuid`;
}

function text(values: readonly string[]): SQL {
  return sql`${sql.param([...values])}::text[]`;
}

/** `count(*)` over at most `cap` rows of `rows`: the work is bounded, not only the answer. */
function capped(rows: SQL, cap: number): SQL {
  return sql`SELECT count(*)::int AS n FROM (${rows} LIMIT ${cap}) capped`;
}
