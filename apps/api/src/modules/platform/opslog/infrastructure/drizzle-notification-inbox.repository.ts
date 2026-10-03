import { sql, type SQL } from 'drizzle-orm';
import {
  OPERATIONAL_SEVERITIES,
  type NotificationRule,
  type OperationalSeverity,
  type TenantContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  InboxFilter,
  InboxRow,
  NotificationInboxRepository,
} from '../application/notification-center.ports.js';

/** The severities at or above `min`, in the contract's order. */
function severitiesFrom(min: OperationalSeverity): readonly OperationalSeverity[] {
  return OPERATIONAL_SEVERITIES.slice(OPERATIONAL_SEVERITIES.indexOf(min));
}

/**
 * The rules as ONE predicate over `e` (operational_events). Exact codes win over prefixes,
 * as `notificationRuleFor` decides in the application: a prefix rule never claims a code
 * that some exact rule names. `starts_with`, never `LIKE` — `_` is a wildcard there. Every
 * value is a bound parameter. An empty rule set is `false`: no category, no rows.
 */
export function rulePredicate(
  rules: readonly NotificationRule[],
  allRules: readonly NotificationRule[],
): SQL {
  if (rules.length === 0) return sql`false`;
  const exactCodes = allRules.flatMap((rule) => (rule.code === undefined ? [] : [rule.code]));
  const parts = rules.map((rule) => {
    const severities = sql`e.severity = ANY(${sql.param([...severitiesFrom(rule.minSeverity)])}::text[])`;
    if (rule.code !== undefined) return sql`(e.code = ${rule.code} AND ${severities})`;
    return sql`(starts_with(e.code, ${rule.prefix ?? ''})
      AND NOT (e.code = ANY(${sql.param(exactCodes)}::text[])) AND ${severities})`;
  });
  return sql`(${sql.join(parts, sql` OR `)})`;
}

const UNREAD = sql`(r.read_through IS NULL OR e.last_seen_at > r.read_through)`;

interface RawRow {
  readonly id: string;
  readonly code: string;
  readonly severity: string;
  readonly message: string;
  readonly context: Record<string, unknown> | null;
  readonly occurrence_count: number;
  readonly first_seen_at: Date | string;
  readonly last_seen_at: Date | string;
  readonly resolved_at: Date | string | null;
  readonly unread: boolean;
}

const asDate = (value: Date | string) => (value instanceof Date ? value : new Date(value));

function toRow(row: RawRow): InboxRow {
  return {
    id: row.id,
    code: row.code,
    severity: row.severity as OperationalSeverity,
    message: row.message,
    context: row.context,
    occurrenceCount: Number(row.occurrence_count),
    firstSeenAt: asDate(row.first_seen_at),
    lastSeenAt: asDate(row.last_seen_at),
    resolvedAt: row.resolved_at === null ? null : asDate(row.resolved_at),
    read: !row.unread,
  };
}

/**
 * The notification inbox over `operational_events` (Phase B3). Reads only the caller's
 * tenant — never a SYSTEM-scoped row (null tenant), exactly as the operations log — and
 * joins one administrator's read marks. The one write is to `admin_notification_reads`.
 */
export class DrizzleNotificationInboxRepository implements NotificationInboxRepository {
  constructor(
    private readonly db: Database,
    /** Every rule, for exact-before-prefix precedence. */
    private readonly allRules: readonly NotificationRule[],
  ) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  private visible(tenantId: string, filter: InboxFilter): SQL {
    return sql`e.tenant_id = ${tenantId}
      AND e.recovers_code IS NULL
      AND e.last_seen_at >= ${filter.windowStart}
      AND ${rulePredicate(filter.rules, this.allRules)}
      ${filter.unreadOnly ? sql`AND ${UNREAD}` : sql``}`;
  }

  private from(tenantId: string, adminId: string): SQL {
    return sql`operational_events e
      LEFT JOIN admin_notification_reads r
        ON r.tenant_id = ${tenantId} AND r.admin_id = ${adminId} AND r.event_id = e.id`;
  }

  async list(
    scope: TenantContext,
    filter: InboxFilter,
    page: { readonly limit: number; readonly before: { at: Date; id: string } | null },
  ): Promise<readonly InboxRow[]> {
    const tenantId = requireTenantId(scope);
    const before =
      page.before === null
        ? sql``
        : sql`AND (e.first_seen_at, e.id) < (${page.before.at}::timestamptz, ${page.before.id}::uuid)`;
    const result = await this.db.execute(sql`
      SELECT e.id, e.code, e.severity, e.message, e.context, e.occurrence_count,
             e.first_seen_at, e.last_seen_at, e.resolved_at, ${UNREAD} AS unread
        FROM ${this.from(tenantId, filter.adminId)}
       WHERE ${this.visible(tenantId, filter)} ${before}
       ORDER BY e.first_seen_at DESC, e.id DESC
       LIMIT ${Math.max(1, page.limit)}`);
    return (result.rows as unknown as RawRow[]).map(toRow);
  }

  async find(
    scope: TenantContext,
    filter: InboxFilter,
    eventId: string,
    tx?: unknown,
  ): Promise<InboxRow | null> {
    const tenantId = requireTenantId(scope);
    const result = await this.exec(tx).execute(sql`
      SELECT e.id, e.code, e.severity, e.message, e.context, e.occurrence_count,
             e.first_seen_at, e.last_seen_at, e.resolved_at, ${UNREAD} AS unread
        FROM ${this.from(tenantId, filter.adminId)}
       WHERE e.id = ${eventId}::uuid AND ${this.visible(tenantId, filter)}
       LIMIT 1`);
    const [row] = result.rows as unknown as RawRow[];
    return row === undefined ? null : toRow(row);
  }

  async unread(
    scope: TenantContext,
    filter: InboxFilter,
    cap: number,
  ): Promise<{ readonly count: number; readonly highest: OperationalSeverity | null }> {
    const tenantId = requireTenantId(scope);
    const unreadOnly = { ...filter, unreadOnly: true };
    // The count is bounded by the cap: beyond it is "that many or more". The capped subset
    // is the MOST SEVERE `cap` rows, never an arbitrary `cap`: the bell's tone is the
    // highest severity among ALL the unread, and a CRITICAL that an unordered LIMIT left
    // out would paint the bell a lower tone than the inbox holds. The range is the
    // `(tenant_id, last_seen_at)` index's, bounded by the window, so the ordering is a
    // top-N sort over rows that scan reads anyway.
    const ranks = sql.param([...OPERATIONAL_SEVERITIES]);
    const result = await this.db.execute(sql`
      SELECT count(*)::int AS n, max(e.rank) AS rank
        FROM (SELECT array_position(${ranks}::text[], e.severity) AS rank
                FROM ${this.from(tenantId, filter.adminId)}
               WHERE ${this.visible(tenantId, unreadOnly)}
               ORDER BY 1 DESC
               LIMIT ${Math.max(1, cap)}) e`);
    const [row] = result.rows as unknown as { n: number; rank: number | null }[];
    const rank = row?.rank ?? null;
    return {
      count: Number(row?.n ?? 0),
      highest: rank === null ? null : (OPERATIONAL_SEVERITIES[Number(rank) - 1] ?? null),
    };
  }

  async mark(
    scope: TenantContext,
    adminId: string,
    eventId: string,
    read: boolean,
    now: Date,
    tx: TransactionScope,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    // The read mark is the event's last-seen AS OF THIS STATEMENT, read from the row
    // itself: a recurrence that commits afterwards is unread again, one that committed
    // before is read.
    await this.exec(tx).execute(sql`
      INSERT INTO admin_notification_reads (tenant_id, admin_id, event_id, read_through, updated_at)
      SELECT ${tenantId}, ${adminId}, e.id, ${read ? sql`e.last_seen_at` : sql`NULL`}, ${now}
        FROM operational_events e
       WHERE e.tenant_id = ${tenantId} AND e.id = ${eventId}::uuid
      ON CONFLICT (tenant_id, admin_id, event_id)
      DO UPDATE SET read_through = EXCLUDED.read_through, updated_at = EXCLUDED.updated_at`);
  }

  async markAll(
    scope: TenantContext,
    filter: InboxFilter,
    now: Date,
    tx: TransactionScope,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    const unreadOnly = { ...filter, unreadOnly: true };
    const result = await this.exec(tx).execute(sql`
      INSERT INTO admin_notification_reads (tenant_id, admin_id, event_id, read_through, updated_at)
      SELECT ${tenantId}, ${filter.adminId}, e.id, e.last_seen_at, ${now}
        FROM ${this.from(tenantId, filter.adminId)}
       WHERE ${this.visible(tenantId, unreadOnly)}
      ON CONFLICT (tenant_id, admin_id, event_id)
      DO UPDATE SET read_through = EXCLUDED.read_through, updated_at = EXCLUDED.updated_at
      RETURNING event_id`);
    return result.rows.length;
  }
}
