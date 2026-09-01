import { sql } from 'drizzle-orm';
import {
  type Clock,
  type IdGenerator,
  type OperationalEventInput,
  type OperationalEventRecorder,
  type ScopeContext,
} from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { operationalEvents } from '../../../../infrastructure/persistence/schema.js';
import { scopeRef, scopeTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';
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

  async record(scope: ScopeContext, event: OperationalEventInput): Promise<void> {
    const now = this.clock.now();
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

    if (event.dedupeKey === undefined) {
      await this.db.insert(operationalEvents).values(values);
      return;
    }

    await this.db
      .insert(operationalEvents)
      .values(values)
      .onConflictDoUpdate({
        target: [operationalEvents.dedupeScope, operationalEvents.dedupeKey],
        set: {
          occurrenceCount: sql`${operationalEvents.occurrenceCount} + 1`,
          lastSeenAt: now,
          correlationId: values.correlationId,
          context: values.context,
        },
      });
  }
}
