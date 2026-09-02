import { and, desc, eq, gte, inArray, isNotNull, isNull, lt } from 'drizzle-orm';
import type { OperationalSeverity, ScopeContext } from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { operationalEvents } from '../../../../infrastructure/persistence/schema.js';
import { requireTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
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
    if (query.before) filters.push(lt(operationalEvents.lastSeenAt, query.before));
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
      .orderBy(desc(operationalEvents.lastSeenAt))
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
