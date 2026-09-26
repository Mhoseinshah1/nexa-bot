import type {
  ActorType,
  AuditResult,
  PermissionKey,
  SourceSurface,
  TenantContext,
} from '@nexa/contracts';

/** Reading the audit trail. Held by owner, observer and finance (seeded roles). */
export const AUDIT_VIEW_PERMISSION: PermissionKey = 'audit.view';

/**
 * Reading the audit log back (`docs/wp14-reseller-phase2-audit.md` D3).
 *
 * The writer is `AuditWriter`, in the contract. This is its one reader, and it answers
 * exactly one question: what was recorded against ONE entity of ONE tenant, under actions
 * that start with a given prefix. It is not a log browser — a paged, filtered browser is a
 * different surface with its own permission story — and it never returns the actor's IP or
 * user agent, which the row holds for forensics and no entity panel needs.
 */

export interface AuditHistoryRecord {
  readonly id: string;
  readonly action: string;
  readonly actorType: ActorType;
  readonly actorLabel: string | null;
  readonly surface: SourceSurface;
  readonly result: AuditResult;
  readonly occurredAt: Date;
  /** As stored: redacted at write time. Null when the row has none, or it is not an object. */
  readonly before: Readonly<Record<string, unknown>> | null;
  readonly after: Readonly<Record<string, unknown>> | null;
}

export interface AuditHistoryReader {
  /** Newest first, at most `limit` rows. Another tenant's rows are never returned. */
  entityHistory(
    scope: TenantContext,
    query: {
      readonly entityType: string;
      readonly entityId: string;
      readonly actionPrefix: string;
    },
    limit: number,
  ): Promise<readonly AuditHistoryRecord[]>;
}
