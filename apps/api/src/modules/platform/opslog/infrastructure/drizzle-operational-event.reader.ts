import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import {
  MANAGEMENT_EVENT_CODES,
  MANAGEMENT_CONDITION_FAILURE_CODES,
  type OperationalSeverity,
  type ScopeContext,
} from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { operationalEvents } from '../../../../infrastructure/persistence/schema.js';
import {
  requireTenantId,
  scopeRef,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
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

    // Ordered by `first_seen_at` descending, served by
    // `operational_events_tenant_first_seen_page_idx` on
    // `(tenant_id, first_seen_at, id)` — which is built concurrently outside
    // the migrator, see `online-indexes.ts`. This comment named `last_seen_at`
    // and its index for one commit after the ordering had moved, five lines
    // above the block that says the opposite: the sentence a maintainer would
    // read to conclude the ordering was indexed, while it was not.
    //
    // The legacy `/admin/logs` has 1,700 rows, no pagination and no filter of
    // any kind; every clause below is there because that is what an operator
    // does with a log.
    const filters = [eq(operationalEvents.tenantId, tenantId)];
    // The cursor is a PAIR, `(first_seen_at, id)`, and the comparison is
    // lexicographic. `first_seen_at` alone is not unique — a `Clock.now()` is
    // typically captured once per transaction, so several distinct conditions
    // share one microsecond — and a strict `<` on it skips the rest of a group
    // that straddles the page boundary. Rows would simply not appear on any
    // page, in a subsystem whose stated rule is that silence is the one outcome
    // it may not produce.
    /*
     * `first_seen_at`, which is IMMUTABLE. Not `last_seen_at`.
     *
     * OWNER DECISION. `last_seen_at` is rewritten by every repeat occurrence of
     * a deduped condition — that is what the occurrence counter is for — so a
     * row currently below the operator's cursor that recurs jumps ABOVE it and
     * is returned on no subsequent page. It is the same argument that moved the
     * panel keyset off `name`, applied to the one subsystem whose stated rule
     * is that silence is the outcome it may not produce.
     *
     * `first_seen_at` never changes after the insert, so a row cannot cross a
     * cursor while an operator pages. `last_seen_at` is still returned and
     * still displayed as the latest occurrence — it is operational metadata,
     * not a traversal key.
     *
     * This deliberately changes what the list MEANS: it is ordered by when a
     * condition first appeared, not by when it was last active. A
     * most-recently-active view is a separate design with its own pagination
     * semantics for a mutable ordering column, and is not bought by
     * compromising this keyset.
     */
    if (query.before) {
      filters.push(
        query.beforeId === undefined
          ? lt(operationalEvents.firstSeenAt, query.before)
          : or(
              lt(operationalEvents.firstSeenAt, query.before),
              and(
                eq(operationalEvents.firstSeenAt, query.before),
                lt(operationalEvents.id, query.beforeId),
              ),
            )!,
      );
    }
    if (query.severities && query.severities.length > 0) {
      filters.push(inArray(operationalEvents.severity, [...query.severities]));
    }
    if (query.code) filters.push(eq(operationalEvents.code, query.code));
    // The management scope, applied HERE so that `limit` bounds the rows the
    // reader will actually see and the cursor advances over the same set. A
    // browser-side filter would leave the cursor having already walked past
    // everything it discarded, so paging would silently drop rows.
    //
    // `MANAGEMENT_CONDITIONS` is the narrower list: the FAILURE codes. The
    // dashboard asks for it, because a card headed "needs attention" must
    // carry neither one-shot records nothing can resolve nor the recoveries
    // that announce a condition is over.
    //
    // Both are `inArray` over compile-time constants from the contract. There
    // is no `like` here any more, and that is deliberate: the prefix form it
    // replaced matched nothing in production, and SQL `LIKE` treats `_` as a
    // single-character wildcard, so a prefix such as `panel_monitor.` would
    // have quietly matched more than the shared predicate did.
    if (query.scope === 'MANAGEMENT') {
      filters.push(inArray(operationalEvents.code, [...MANAGEMENT_EVENT_CODES]));
    }
    if (query.scope === 'MANAGEMENT_CONDITIONS') {
      // FAILURES only, not the whole lifecycle. A recovery row is inserted
      // with its own `resolvedAt` null — it closes the failure, never itself —
      // so selecting the lifecycle here made every recovery an open condition
      // and left "needs attention" populated by the rows announcing that
      // attention is no longer needed.
      filters.push(inArray(operationalEvents.code, [...MANAGEMENT_CONDITION_FAILURE_CODES]));
    }
    /*
     * Half-open `[since, until)`: an event at exactly `until` belongs to the
     * next interval, so two adjacent reports never double-count it.
     *
     * Still on `last_seen_at`, deliberately, even though the keyset moved to
     * `first_seen_at`. These are an ACTIVITY filter — "what was happening in
     * this window" — and a condition that first appeared last month and
     * recurred this morning belongs in this morning's window. Filtering and
     * ordering are independent predicates; conflating them because they now
     * name different columns would change what a report counts, which is not
     * what the keyset decision was about.
     */
    if (query.since) filters.push(gte(operationalEvents.lastSeenAt, query.since));
    if (query.until) filters.push(lt(operationalEvents.lastSeenAt, query.until));
    if (query.open === true) filters.push(isNull(operationalEvents.resolvedAt));
    if (query.open === false) filters.push(isNotNull(operationalEvents.resolvedAt));

    const rows = await this.db
      .select()
      .from(operationalEvents)
      .where(and(...filters))
      // Both columns, matching the cursor above, and BOTH immutable. Without
      // the tie-break the order within a shared timestamp is arbitrary and the
      // cursor cannot resume from it — `first_seen_at` is a `Clock.now()`
      // captured once per transaction, so distinct conditions really do share
      // one microsecond and the id is what separates them deterministically.
      .orderBy(desc(operationalEvents.firstSeenAt), desc(operationalEvents.id))
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

  async tenantConditionIsOpen(
    tenantId: string,
    code: string,
    tx?: TransactionScope,
  ): Promise<boolean> {
    const rows = await (tx?.tx ?? this.db)
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

  /**
   * Whether ONE SUBJECT'S condition is open, addressed by its dedupe key.
   *
   * `tenantConditionIsOpen` answers the question for a whole tenant and a code,
   * which is the right question for a condition there can only be one of. It is
   * the wrong one for a condition that is ABOUT something: a tenant with two bot
   * instances would be told "open" because the OTHER bot is broken, and a
   * recovery written on that answer resolves nothing while still appending a
   * row — once per message, for as long as the other bot stayed broken.
   *
   * So this is keyed exactly as the recorder dedupes — `dedupe_scope` and
   * `dedupe_key`, which carry a unique index together — and the answer is about
   * the one row a recovery would actually resolve.
   */
  async conditionIsOpen(
    scope: ScopeContext,
    dedupeKey: string,
    tx?: TransactionScope,
  ): Promise<boolean> {
    const rows = await (tx?.tx ?? this.db)
      .select({ id: operationalEvents.id })
      .from(operationalEvents)
      .where(
        and(
          eq(operationalEvents.dedupeScope, scopeRef(scope, 'OPSLOG')),
          eq(operationalEvents.dedupeKey, dedupeKey),
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
