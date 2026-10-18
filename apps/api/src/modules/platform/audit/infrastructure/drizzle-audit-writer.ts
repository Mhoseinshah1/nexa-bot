import {
  type ActorContext,
  type AuditEntry,
  type Clock,
  type IdGenerator,
  type ScopeContext,
} from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { auditLogs } from '../../../../infrastructure/persistence/schema.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { scopeTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';
import { redactRecord } from '../../../../infrastructure/redaction.js';
import type { BulkAuditWriter } from '../application/record-audit-many.js';

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

/** Audit rows per INSERT: 18 parameters a row, so 3 000 rows stay under PostgreSQL's 65 535. */
const AUDIT_INSERT_CHUNK = 3000;

export class DrizzleAuditWriter implements BulkAuditWriter {
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

    await executor.insert(auditLogs).values(this.row(scope, actor, entry));
  }

  /**
   * `record` for many entries of ONE actor, in as few statements as the bind-parameter limit
   * allows: the same rows, in the same order, each with its own id and `occurredAt`. For a
   * bulk writer (the one-time import) inside its own transaction.
   */
  async recordMany(
    scope: ScopeContext,
    actor: ActorContext,
    entries: readonly AuditEntry[],
    tx?: unknown,
  ): Promise<void> {
    const executor = (tx as TransactionScope | undefined)?.tx ?? this.db;
    const rows = entries.map((entry) => this.row(scope, actor, entry));
    for (let i = 0; i < rows.length; i += AUDIT_INSERT_CHUNK) {
      await executor.insert(auditLogs).values(rows.slice(i, i + AUDIT_INSERT_CHUNK));
    }
  }

  private row(scope: ScopeContext, actor: ActorContext, entry: AuditEntry) {
    return {
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
    };
  }
}
