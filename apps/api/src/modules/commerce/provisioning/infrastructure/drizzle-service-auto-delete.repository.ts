import { sql, type SQL } from 'drizzle-orm';
import {
  UNLIMITED_TRAFFIC_BYTES,
  type AutoDeleteCause,
  type AutoDeleteRunState,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { ScopeBound } from '../../../../infrastructure/persistence/database-scope.js';
import type {
  AutoDeleteCandidate,
  AutoDeleteDays,
  AutoDeletePreviewCounts,
  AutoDeleteRepository,
  AutoDeleteRun,
} from '../application/service-auto-delete.ports.js';

type Row = Record<string, unknown>;

function dateOf(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

/**
 * The cycle's cause, over `services s`. SUSPENDED is its own; an EXPIRED service's is the one
 * stored when it expired, or — for a row expired before the column — the same rule derived
 * from the same columns (`SERVICE_EXPIRY_CAUSE_SQL`): a read usage at a FINITE limit is TRAFFIC.
 */
const CAUSE = sql.raw(`CASE WHEN s.state = 'SUSPENDED' THEN 'SUSPENDED'
  ELSE COALESCE(s.expiry_cause,
    CASE WHEN s.usage_synced_at IS NOT NULL
          AND s.traffic_limit_bytes <> ${String(UNLIMITED_TRAFFIC_BYTES)}
          AND s.traffic_used_bytes >= s.traffic_limit_bytes
         THEN 'TRAFFIC' ELSE 'TIME' END) END`);

/** The configured day count of a cause expression; `0` is off. */
function daysOf(cause: SQL, days: AutoDeleteDays): SQL {
  return sql`(CASE ${cause} WHEN 'TRAFFIC' THEN ${days.traffic}::int
                            WHEN 'TIME' THEN ${days.time}::int
                            ELSE ${days.suspended}::int END)`;
}

/**
 * What keeps a service, over `services s` (spec §3): an open order for it (a draft or one
 * awaiting payment), a payment of such an order not yet decided — PENDING covers a receipt under
 * review — or UNKNOWN, an operation still open on it (a paid renewal waiting, a resume, an
 * operator's terminate), or an open refund request. Only the reads (`SYNC_USAGE`, `RECONCILE`)
 * do not keep it: a background usage read must not hold a deletion off for ever.
 */
const NOT_BLOCKED = sql.raw(`NOT EXISTS (
    SELECT 1 FROM provisioning_operations op
     WHERE op.tenant_id = s.tenant_id AND op.service_id = s.id
       AND op.state IN ('PLANNED', 'IN_FLIGHT')
       AND op.type NOT IN ('SYNC_USAGE', 'RECONCILE'))
  AND NOT EXISTS (
    SELECT 1 FROM service_commercial_actions a
      JOIN orders o ON o.tenant_id = a.tenant_id AND o.id = a.order_id
     WHERE a.tenant_id = s.tenant_id AND a.service_id = s.id
       AND (o.state IN ('DRAFT', 'AWAITING_PAYMENT')
            OR EXISTS (SELECT 1 FROM payments p
                        WHERE p.tenant_id = o.tenant_id AND p.order_id = o.id
                          AND p.state IN ('PENDING', 'UNKNOWN'))))
  AND NOT EXISTS (
    SELECT 1 FROM service_refund_requests q
     WHERE q.tenant_id = s.tenant_id AND q.service_id = s.id AND q.state = 'OPEN')`);

const RUN_COLUMNS = sql.raw(`r.id, r.service_id, r.customer_id, r.panel_id, r.cycle_state,
  r.cycle_since, r.cause, r.days, r.service_label, r.delete_after, r.warned_at, r.state`);

function runOf(row: Row): AutoDeleteRun {
  return {
    id: String(row['id']),
    serviceId: String(row['service_id']),
    customerId: String(row['customer_id']) as UserId,
    panelId: String(row['panel_id']),
    cycleState: String(row['cycle_state']) as 'EXPIRED' | 'SUSPENDED',
    cycleSince: dateOf(row['cycle_since']),
    cause: String(row['cause']) as AutoDeleteCause,
    days: Number(row['days']),
    serviceLabel: String(row['service_label']),
    deleteAfter: dateOf(row['delete_after']),
    warnedAt: row['warned_at'] === null ? null : dateOf(row['warned_at']),
    state: String(row['state']) as AutoDeleteRunState,
  };
}

/** NEXA-OWNER-BATCH-1 PR-3: the automatic deletion's SQL. */
@ScopeBound()
export class DrizzleServiceAutoDeleteRepository implements AutoDeleteRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  private async rows(tx: unknown, query: SQL): Promise<Row[]> {
    const result = await this.exec(tx).execute(query);
    return result.rows as Row[];
  }

  async stampUnknownClocks(
    scope: TenantContext,
    now: Date,
    limit: number,
    tx: TransactionScope,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    const rows = await this.rows(
      tx,
      sql`UPDATE services SET state_since = ${now}
           WHERE tenant_id = ${tenantId}
             AND state IN ('EXPIRED', 'SUSPENDED')
             AND state_since IS NULL
             AND id IN (SELECT id FROM services
                         WHERE tenant_id = ${tenantId}
                           AND state IN ('EXPIRED', 'SUSPENDED')
                           AND state_since IS NULL
                         ORDER BY id LIMIT ${limit})
         RETURNING id`,
    );
    return rows.length;
  }

  async listToSchedule(
    scope: TenantContext,
    input: { readonly horizon: Date; readonly days: AutoDeleteDays },
    limit: number,
    tx: TransactionScope,
  ): Promise<readonly AutoDeleteCandidate[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.rows(
      tx,
      sql`SELECT s.id, s.customer_id, s.panel_id, s.state, s.provider_username, c.cause, d.days,
                 s.state_since + make_interval(days => d.days) AS due_at
            FROM services s
            CROSS JOIN LATERAL (SELECT ${CAUSE} AS cause) c
            CROSS JOIN LATERAL (SELECT ${daysOf(sql.raw('c.cause'), input.days)} AS days) d
           WHERE s.tenant_id = ${tenantId}
             AND s.state IN ('EXPIRED', 'SUSPENDED')
             AND s.state_since IS NOT NULL
             AND d.days > 0
             AND s.state_since + make_interval(days => d.days) <= ${input.horizon}
             AND NOT EXISTS (SELECT 1 FROM service_auto_delete_runs r
                              WHERE r.tenant_id = s.tenant_id AND r.service_id = s.id
                                AND r.cycle_since = s.state_since)
             AND ${NOT_BLOCKED}
           ORDER BY s.state_since, s.id
           LIMIT ${limit}`,
    );
    return rows.map((row) => ({
      serviceId: String(row['id']),
      customerId: String(row['customer_id']) as UserId,
      panelId: String(row['panel_id']),
      cycleState: String(row['state']) as 'EXPIRED' | 'SUSPENDED',
      cause: String(row['cause']) as AutoDeleteCause,
      days: Number(row['days']),
      serviceLabel: String(row['provider_username']),
      dueAt: dateOf(row['due_at']),
    }));
  }

  async schedule(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly candidate: AutoDeleteCandidate;
      readonly deleteAfter: Date;
      readonly warnedAt: Date | null;
      readonly now: Date;
    },
    tx: TransactionScope,
  ): Promise<AutoDeleteRun | null> {
    const tenantId = requireTenantId(scope);
    const c = input.candidate;
    // `cycle_since` is copied in SQL from the row, so the cycle's identity is exact.
    const rows = await this.rows(
      tx,
      sql`INSERT INTO service_auto_delete_runs AS r
            (id, tenant_id, service_id, customer_id, panel_id, cycle_state, cycle_since, cause,
             days, service_label, delete_after, warned_at, state, created_at, updated_at)
          SELECT ${input.id}, s.tenant_id, s.id, s.customer_id, s.panel_id, s.state,
                 s.state_since, ${c.cause}, ${c.days}, s.provider_username, ${input.deleteAfter},
                 ${input.warnedAt}, 'SCHEDULED', ${input.now}, ${input.now}
            FROM services s
           WHERE s.tenant_id = ${tenantId} AND s.id = ${c.serviceId}
             AND s.state = ${c.cycleState} AND s.state_since IS NOT NULL
          ON CONFLICT ON CONSTRAINT service_auto_delete_runs_cycle_key DO NOTHING
          RETURNING ${RUN_COLUMNS}`,
    );
    const row = rows[0];
    return row === undefined ? null : runOf(row);
  }

  /** The deletable cycles' shared predicate, over `service_auto_delete_runs r`. */
  private deletable(
    tenantId: string,
    input: { readonly now: Date; readonly days: AutoDeleteDays },
  ): SQL {
    return sql`FROM service_auto_delete_runs r
            JOIN services s
              ON s.tenant_id = r.tenant_id AND s.id = r.service_id
             AND s.state = r.cycle_state AND s.state_since = r.cycle_since
             AND s.customer_id = r.customer_id
            CROSS JOIN LATERAL (SELECT ${daysOf(sql.raw('r.cause'), input.days)} AS days) d
           WHERE r.tenant_id = ${tenantId}
             AND r.state = 'SCHEDULED'
             AND r.delete_after <= ${input.now}
             AND d.days > 0
             AND r.cycle_since + make_interval(days => d.days) <= ${input.now}`;
  }

  async deletablePanels(
    scope: TenantContext,
    input: { readonly now: Date; readonly days: AutoDeleteDays },
    tx: TransactionScope,
  ): Promise<readonly string[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.rows(
      tx,
      sql`SELECT DISTINCT r.panel_id ${this.deletable(tenantId, input)} ORDER BY r.panel_id`,
    );
    return rows.map((row) => String(row['panel_id']));
  }

  async lockPanelRate(scope: TenantContext, panelId: string, tx: TransactionScope): Promise<void> {
    const tenantId = requireTenantId(scope);
    await this.rows(
      tx,
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`auto-delete:${tenantId}:${panelId}`}, 0))`,
    );
  }

  async listDeletable(
    scope: TenantContext,
    input: { readonly now: Date; readonly days: AutoDeleteDays; readonly panelId: string },
    limit: number,
    tx: TransactionScope,
  ): Promise<readonly AutoDeleteRun[]> {
    const tenantId = requireTenantId(scope);
    /*
     * Judged against the settings NOW, not those it was scheduled under: a day count raised
     * or switched off since the warning holds the deletion back (never brings it forward —
     * `delete_after` is a floor).
     */
    const rows = await this.rows(
      tx,
      sql`SELECT ${RUN_COLUMNS} ${this.deletable(tenantId, input)}
             AND r.panel_id = ${input.panelId}
           ORDER BY r.delete_after, r.id
           LIMIT ${limit}`,
    );
    return rows.map(runOf);
  }

  async stillDeletable(
    scope: TenantContext,
    runId: string,
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.rows(
      tx,
      sql`SELECT 1
            FROM service_auto_delete_runs r
            JOIN services s
              ON s.tenant_id = r.tenant_id AND s.id = r.service_id
             AND s.state = r.cycle_state AND s.state_since = r.cycle_since
             AND s.customer_id = r.customer_id
           WHERE r.tenant_id = ${tenantId} AND r.id = ${runId} AND r.state = 'SCHEDULED'
           LIMIT 1`,
    );
    return rows.length > 0;
  }

  async plannedOnPanelSince(
    scope: TenantContext,
    panelId: string,
    since: Date,
    tx: TransactionScope,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    const rows = await this.rows(
      tx,
      sql`SELECT count(*)::int AS n FROM service_auto_delete_runs
           WHERE tenant_id = ${tenantId} AND panel_id = ${panelId}
             AND state = 'PLANNED' AND planned_at > ${since}`,
    );
    return Number(rows[0]?.['n'] ?? 0);
  }

  async isBlocked(scope: TenantContext, serviceId: string, tx: TransactionScope): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.rows(
      tx,
      sql`SELECT 1 FROM services s
           WHERE s.tenant_id = ${tenantId} AND s.id = ${serviceId} AND ${NOT_BLOCKED}`,
    );
    return rows.length === 0;
  }

  async markPlanned(
    scope: TenantContext,
    input: { readonly runId: string; readonly operationId: string; readonly now: Date },
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.rows(
      tx,
      sql`UPDATE service_auto_delete_runs
             SET state = 'PLANNED', operation_id = ${input.operationId},
                 planned_at = ${input.now}, updated_at = ${input.now}
           WHERE tenant_id = ${tenantId} AND id = ${input.runId} AND state = 'SCHEDULED'
         RETURNING id`,
    );
    return rows.length === 1;
  }

  async noticeFacts(
    scope: TenantContext,
    runId: string,
  ): Promise<{
    readonly serviceId: string;
    readonly serviceLabel: string;
    readonly deleteAfter: Date;
  } | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.rows(
      undefined,
      sql`SELECT service_id, service_label, delete_after FROM service_auto_delete_runs
           WHERE tenant_id = ${tenantId} AND id = ${runId}`,
    );
    if (row === undefined) return null;
    return {
      serviceId: String(row['service_id']),
      serviceLabel: String(row['service_label']),
      deleteAfter: dateOf(row['delete_after']),
    };
  }

  async preview(
    scope: TenantContext,
    input: {
      readonly now: Date;
      readonly windowEnd: Date;
      readonly days: AutoDeleteDays;
      readonly warnHours: number;
    },
  ): Promise<AutoDeletePreviewCounts> {
    const tenantId = requireTenantId(scope);
    /*
     * The moment each service could be deleted with THESE settings: its due moment, and — for
     * one not yet scheduled — no sooner than a warning raised now would allow; a scheduled one
     * keeps its own `delete_after`. Already planned cycles are not counted again.
     */
    const rows = await this.rows(
      undefined,
      sql`SELECT c.cause, count(*)::int AS n
            FROM services s
            CROSS JOIN LATERAL (SELECT ${CAUSE} AS cause) c
            CROSS JOIN LATERAL (SELECT ${daysOf(sql.raw('c.cause'), input.days)} AS days) d
            LEFT JOIN service_auto_delete_runs r
              ON r.tenant_id = s.tenant_id AND r.service_id = s.id
             AND r.cycle_since = s.state_since
           WHERE s.tenant_id = ${tenantId}
             AND s.state IN ('EXPIRED', 'SUSPENDED')
             AND s.state_since IS NOT NULL
             AND d.days > 0
             AND (r.id IS NULL OR r.state = 'SCHEDULED')
             AND GREATEST(
                   s.state_since + make_interval(days => d.days),
                   COALESCE(r.delete_after, ${input.now}::timestamptz
                                            + make_interval(hours => ${input.warnHours}::int))
                 ) <= ${input.windowEnd}
             AND ${NOT_BLOCKED}
           GROUP BY c.cause`,
    );
    const count = (cause: AutoDeleteCause): number =>
      Number(rows.find((row) => row['cause'] === cause)?.['n'] ?? 0);
    return { traffic: count('TRAFFIC'), time: count('TIME'), suspended: count('SUSPENDED') };
  }
}
