import {
  type ActorContext,
  type AuditEntry,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type ScopeContext,
} from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { auditLogs } from '../../../../infrastructure/persistence/schema.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { scopeTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';
import { redactRecord } from '../../../../infrastructure/redaction.js';

/**
 * The audit log.
 *
 * Written INSIDE the business transaction, so a change and its record commit
 * together. `action` is a machine code; `before` and `after` hold values rather
 * than references, so the row still means something after the referenced entity
 * changes. Denials are recorded too, with `result = 'DENIED'`.
 *
 * The database refuses UPDATE and DELETE on this table (0001_append_only_guards).
 *
 * Contrast with the legacy `/admin/logs`: a free-text Persian sentence, one
 * customer id, no entity type, no before/after — an activity feed that cannot
 * answer "who changed this, and to what".
 */

export class DrizzleAuditWriter implements AuditWriter {
  constructor(
    private readonly db: Database,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async record(
    scope: ScopeContext,
    actor: ActorContext,
    entry: AuditEntry,
    tx?: unknown,
  ): Promise<void> {
    const executor = (tx as TransactionScope | undefined)?.tx ?? this.db;

    await executor.insert(auditLogs).values({
      id: this.ids.uuid(),
      tenantId: scopeTenantId(scope),
      occurredAt: this.clock.now(),
      actorType: actor.type,
      actorId: actor.id,
      actorLabel: actor.label,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      before: redactRecord(entry.before),
      after: redactRecord(entry.after),
      reason: entry.reason ?? null,
      correlationId: actor.correlationId,
      requestId: actor.requestId ?? null,
      sourceSurface: actor.surface,
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      result: entry.result,
    });
  }
}
