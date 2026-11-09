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
import {
  ScopeBound,
  withSystemScope,
  withSystemScopeIn,
} from '../../../../infrastructure/persistence/database-scope.js';

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

@ScopeBound()
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
    const open = (tx as TransactionScope | undefined)?.tx;
    if (actor.impersonation !== undefined) {
      // D5: the installation owner acting inside a hosted bot. The row is HIS, in HIS log; the
      // hosted tenant's log receives nothing. Same transaction when there is one, so the
      // change and its record still commit together — on the system path, because the
      // transaction is bound to the hosted tenant and RLS would refuse the installation's row.
      const row = this.row(scope, actor, entry);
      if (open === undefined) {
        // The reason is LITERAL here and below, pinned in `tests/unit/system-path-allowlist.ts`.
        await withSystemScope('audit: host owner acting in a hosted tenant', () =>
          this.db.insert(auditLogs).values(row),
        );
      } else {
        await withSystemScopeIn(open, 'audit: host owner acting in a hosted tenant', () =>
          open.insert(auditLogs).values(row),
        );
      }
      return;
    }
    await (open ?? this.db).insert(auditLogs).values(this.row(scope, actor, entry));
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
    if (actor.impersonation !== undefined) {
      // Never batched for an entered session: each goes through `record`'s owner path (D5).
      for (const entry of entries) await this.record(scope, actor, entry, tx);
      return;
    }
    const executor = (tx as TransactionScope | undefined)?.tx ?? this.db;
    const rows = entries.map((entry) => this.row(scope, actor, entry));
    for (let i = 0; i < rows.length; i += AUDIT_INSERT_CHUNK) {
      await executor.insert(auditLogs).values(rows.slice(i, i + AUDIT_INSERT_CHUNK));
    }
  }

  private row(scope: ScopeContext, actor: ActorContext, entry: AuditEntry) {
    const entered = actor.impersonation;
    return {
      id: this.ids.uuid(),
      // An entered session's row is the installation owner's (D5): his tenant, his id and
      // name, and the hosted tenant he acted in. Never the hosted tenant's own log.
      tenantId: entered === undefined ? scopeTenantId(scope) : entered.installationTenantId,
      actedInTenantId: entered === undefined ? null : scopeTenantId(scope),
      occurredAt: this.clock.now(),
      actorType: actor.type,
      actorId: entered === undefined ? actor.id : entered.ownerAdminId,
      actorLabel: entered === undefined ? actor.label : entered.ownerLabel,
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
