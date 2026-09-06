import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import type { OperationalSeverity, ScopeContext } from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { operationalEvents } from '../../../../infrastructure/persistence/schema.js';
import { requireTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  OperationalConditionReader,
  OperationalEventQuery,
  OperationalEventReader,
  OperationalEventRow,
} from '../application/ports.js';

export class DrizzleOperationalEventReader implements OperationalEventReader {
  constructor(private readonly db: Database) {}

  async list(scope: ScopeContext, query: OperationalEventQuery): Promise<OperationalEventRow[]> {
    const tenantId = requireTenantId(scope);

    // Ordered by `last_seen_at` descending, which is what the existing
    // `(tenant_id, last_seen_at)` index serves. The legacy `/admin/logs` has
    // 1,700 rows, no pagination and no filter of any kind; every clause below is
    // there because that is what an operator does with a log.
    const filters = [eq(operationalEvents.tenantId, tenantId)];
    // The cursor is a PAIR, `(last_seen_at, id)`, and the comparison is
    // lexicographic. `last_seen_at` alone is not unique — a `Clock.now()` is
    // typically captured once per transaction, so several distinct conditions
    // share one microsecond — and a strict `<` on it skips the rest of a group
    // that straddles the page boundary. Rows would simply not appear on any
    // page, in a subsystem whose stated rule is that silence is the one outcome
    // it may not produce.
    if (query.before) {
      filters.push(
        query.beforeId === undefined
          ? lt(operationalEvents.lastSeenAt, query.before)
          : or(
              lt(operationalEvents.lastSeenAt, query.before),
              and(
                eq(operationalEvents.lastSeenAt, query.before),
                lt(operationalEvents.id, query.beforeId),
              ),
            )!,
      );
    }
    if (query.severities && query.severities.length > 0) {
      filters.push(inArray(operationalEvents.severity, [...query.severities]));
    }
    if (query.code) filters.push(eq(operationalEvents.code, query.code));
    // Half-open `[since, until)`: an event at exactly `until` belongs to the
    // next interval, so two adjacent reports never double-count it.
    if (query.since) filters.push(gte(operationalEvents.lastSeenAt, query.since));
    if (query.until) filters.push(lt(operationalEvents.lastSeenAt, query.until));
    if (query.open === true) filters.push(isNull(operationalEvents.resolvedAt));
    if (query.open === false) filters.push(isNotNull(operationalEvents.resolvedAt));

    const rows = await this.db
      .select()
      .from(operationalEvents)
      .where(and(...filters))
      // Both columns, matching the cursor above. Without the tie-break the
      // order within a shared timestamp is arbitrary and the cursor cannot
      // resume from it.
      .orderBy(desc(operationalEvents.lastSeenAt), desc(operationalEvents.id))
      .limit(query.limit);

    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      severity: row.severity as OperationalSeverity,
      message: row.message,
      context: row.context as Record<string, unknown> | null,
      occurrenceCount: row.occurrenceCount,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      correlationId: row.correlationId,
      recoversCode: row.recoversCode,
      resolvedAt: row.resolvedAt,
      resolvedByEventId: row.resolvedByEventId,
    }));
  }
}

/**
 * The open-condition reader, over the same rows the operations view reads.
 *
 * Two narrow queries on `operational_events`, both filtered by `resolved_at IS
 * NULL` and both bounded by the code they are asked about. There is an index on
 * `code`; the open set of any one condition is small by construction, because a
 * condition dedupes onto one row per scope.
 */
export class DrizzleOperationalConditionReader implements OperationalConditionReader {
  constructor(private readonly db: Database) {}

  async openTenantConditions(code: string): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ tenantId: operationalEvents.tenantId })
      .from(operationalEvents)
      .where(
        and(
          eq(operationalEvents.code, code),
          isNull(operationalEvents.resolvedAt),
          isNotNull(operationalEvents.tenantId),
        ),
      );
    return rows.flatMap((row) => (row.tenantId === null ? [] : [row.tenantId]));
  }

  async tenantConditionIsOpen(tenantId: string, code: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: operationalEvents.id })
      .from(operationalEvents)
      .where(
        and(
          eq(operationalEvents.code, code),
          eq(operationalEvents.tenantId, tenantId),
          isNull(operationalEvents.resolvedAt),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async systemConditionIsOpen(code: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: operationalEvents.id })
      .from(operationalEvents)
      .where(
        and(
          eq(operationalEvents.code, code),
          isNull(operationalEvents.resolvedAt),
          isNull(operationalEvents.tenantId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }
}
