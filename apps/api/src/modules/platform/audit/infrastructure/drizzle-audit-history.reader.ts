import { and, desc, eq, sql } from 'drizzle-orm';
import type { ActorType, AuditResult, SourceSurface, TenantContext } from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { auditLogs } from '../../../../infrastructure/persistence/schema.js';
import { requireTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { AuditHistoryReader, AuditHistoryRecord } from '../application/ports.js';

/**
 * One entity's audit rows, newest first, through `audit_logs_entity_idx`.
 *
 * The prefix is matched with `starts_with`, never `LIKE`: `reseller_tier.` carries an
 * underscore, which `LIKE` reads as "any character". The columns are listed, so `ip` and
 * `user_agent` are never selected rather than selected and dropped.
 */
export class DrizzleAuditHistoryReader implements AuditHistoryReader {
  constructor(private readonly db: Database) {}

  async entityHistory(
    scope: TenantContext,
    query: {
      readonly entityType: string;
      readonly entityId: string;
      readonly actionPrefix: string;
    },
    limit: number,
  ): Promise<readonly AuditHistoryRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        actorType: auditLogs.actorType,
        actorLabel: auditLogs.actorLabel,
        surface: auditLogs.sourceSurface,
        result: auditLogs.result,
        occurredAt: auditLogs.occurredAt,
        before: auditLogs.before,
        after: auditLogs.after,
      })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.tenantId, tenantId),
          eq(auditLogs.entityType, query.entityType),
          eq(auditLogs.entityId, query.entityId),
          sql`starts_with(${auditLogs.action}, ${query.actionPrefix})`,
        ),
      )
      .orderBy(desc(auditLogs.occurredAt), desc(auditLogs.id))
      .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      actorType: row.actorType as ActorType,
      actorLabel: row.actorLabel,
      surface: row.surface as SourceSurface,
      result: row.result as AuditResult,
      occurredAt: row.occurredAt,
      before: asRecord(row.before),
      after: asRecord(row.after),
    }));
  }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
