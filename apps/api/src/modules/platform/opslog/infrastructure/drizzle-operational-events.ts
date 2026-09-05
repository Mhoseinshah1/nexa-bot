import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  type Clock,
  type IdGenerator,
  type OperationalEventInput,
  type OperationalEventRecorder,
  type OperationalSeverity,
  type RecordedOperationalEvent,
  type ScopeContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import { operationalEvents } from '../../../../infrastructure/persistence/schema.js';
import {
  scopeRef,
  scopeTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { redactRecord } from '../../../../infrastructure/redaction.js';

/**
 * Operational events: what the system did.
 *
 * This is a different thing from the audit log (who changed what) and from a
 * notification (intent to inform someone). The database is the log; Telegram
 * and any webhook are projections filtered by severity.
 *
 * A `dedupeKey` collapses a repeated condition onto one row and increments its
 * counter — the legacy log group recorded 60 identical TLS errors in a single
 * day with no way to suppress or resolve them. `recoversCode` records that a
 * condition cleared, so a fixed problem stops looking broken.
 */
export class DrizzleOperationalEventRecorder implements OperationalEventRecorder {
  constructor(
    private readonly db: Database,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async record(
    scope: ScopeContext,
    event: OperationalEventInput,
    tx?: unknown,
  ): Promise<RecordedOperationalEvent> {
    const now = this.clock.now();
    const caller = (tx as TransactionScope | undefined)?.tx;
    const values = {
      id: this.ids.uuid(),
      tenantId: scopeTenantId(scope),
      code: event.code,
      severity: event.severity,
      message: event.message,
      // Redacted like the audit log: this table is projected into an operations
      // channel, so anything written here leaves the database.
      context: redactRecord((event.context ?? null) as Record<string, unknown> | null),
      // Deduplication is per scope. Globally-unique dedupe keys would let two
      // tenants collapse onto one row and overwrite each other's context.
      dedupeScope: scopeRef(scope, 'OPSLOG'),
      dedupeKey: event.dedupeKey ?? null,
      occurrenceCount: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      correlationId: event.correlationId ?? null,
      recoversCode: event.recoversCode ?? null,
    };

    let row: typeof operationalEvents.$inferSelect | undefined;
    let isNew: boolean;
    let reopened = false;

    if (event.dedupeKey === undefined) {
      [row] = await (caller ?? this.db).insert(operationalEvents).values(values).returning();
      isNew = true;
    } else {
      // The deduplicated path runs in one transaction, so that "was this already
      // open, and had it been resolved" is answered from the same state the
      // write then changes.
      //
      // The shape below is not the obvious one, and the obvious one is wrong.
      // `SELECT ... FOR UPDATE` locks nothing when the row does not exist yet,
      // so two first reports of the same condition arriving together both find
      // nothing, both insert, and one gets a unique violation — which surfaced
      // as an unexplained login failure the first time this was written that
      // way. The insert therefore goes through `ON CONFLICT DO NOTHING`, and
      // returning no row means somebody else won the race and the update path
      // takes over.
      const dedupeKey = event.dedupeKey;
      // Inside the caller's transaction when there is one, and in its own
      // otherwise. The row lock below is what serialises two reports of one
      // condition, and it does that identically either way.
      const dedupe = async (tx: Executor) => {
        const lockExisting = async () => {
          const [found] = await tx
            .select({ id: operationalEvents.id, resolvedAt: operationalEvents.resolvedAt })
            .from(operationalEvents)
            .where(
              and(
                eq(operationalEvents.dedupeScope, values.dedupeScope),
                eq(operationalEvents.dedupeKey, dedupeKey),
              ),
            )
            .limit(1)
            .for('update');
          return found;
        };

        let existing = await lockExisting();

        if (existing === undefined) {
          const [inserted] = await tx
            .insert(operationalEvents)
            .values(values)
            .onConflictDoNothing({
              target: [operationalEvents.dedupeScope, operationalEvents.dedupeKey],
            })
            .returning();
          if (inserted !== undefined) {
            return { row: inserted, isNew: true, reopened: false };
          }
          // A concurrent report inserted it while this transaction was between
          // the lock attempt and the insert. It has committed — `ON CONFLICT DO
          // NOTHING` waited for it — so the row is visible now.
          existing = await lockExisting();
          if (existing === undefined) {
            throw new Error(
              'operational_events insert conflicted but the conflicting row is not visible.',
            );
          }
        }

        const [updated] = await tx
          .update(operationalEvents)
          .set({
            occurrenceCount: sql`${operationalEvents.occurrenceCount} + 1`,
            lastSeenAt: now,
            correlationId: values.correlationId,
            context: values.context,
            // The condition is happening again, so it is not resolved any more.
            // The recovery event that said it had cleared stays in the table:
            // this reopens the row, it does not erase the history.
            resolvedAt: null,
            resolvedByEventId: null,
          })
          .where(eq(operationalEvents.id, existing.id))
          .returning();
        return { row: updated, isNew: false, reopened: existing.resolvedAt !== null };
      };

      const outcome = caller ? await dedupe(caller) : await this.db.transaction(dedupe);

      row = outcome.row;
      isNew = outcome.isNew;
      reopened = outcome.reopened;
    }

    if (row === undefined) {
      throw new Error('operational_events write returned no row.');
    }

    // A recovery event marks the open rows for the code it recovers. It never
    // deletes them: an operator asking "was this broken last night" needs the
    // failure row to still be there, with its counter and its first-seen time.
    if (event.recoversCode !== undefined) {
      await (caller ?? this.db)
        .update(operationalEvents)
        .set({ resolvedAt: now, resolvedByEventId: row.id })
        .where(
          and(
            eq(operationalEvents.dedupeScope, values.dedupeScope),
            eq(operationalEvents.code, event.recoversCode),
            // Narrowed to one SUBJECT when the caller names one. Without this
            // a recovery resolves every open row of that code in the tenant,
            // which is right for "this installation cannot reach Telegram" and
            // wrong for anything that is about a particular setting or panel —
            // repairing one setting was marking every other setting's open
            // complaint resolved.
            ...(event.recoversDedupeKey === undefined
              ? []
              : [eq(operationalEvents.dedupeKey, event.recoversDedupeKey)]),
            isNull(operationalEvents.resolvedAt),
          ),
        );
    }

    return {
      id: row.id,
      code: row.code,
      severity: row.severity as OperationalSeverity,
      message: row.message,
      occurrenceCount: row.occurrenceCount,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      isNew,
      reopened,
    };
  }
}
