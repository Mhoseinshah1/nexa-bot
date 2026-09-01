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
import { scopeTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';

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
      context: (event.context ?? null) as Record<string, unknown> | null,
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
        target: operationalEvents.dedupeKey,
        set: {
          occurrenceCount: sql`${operationalEvents.occurrenceCount} + 1`,
          lastSeenAt: now,
          correlationId: values.correlationId,
          context: values.context,
        },
      });
  }
}
