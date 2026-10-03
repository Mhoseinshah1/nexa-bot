import type {
  ActorType,
  AuditResult,
  AuditSecurityFilter,
  PermissionKey,
  SourceSurface,
  TenantContext,
} from '@nexa/contracts';

/** Reading the audit trail. Held by owner, observer and finance (seeded roles). */
export const AUDIT_VIEW_PERMISSION: PermissionKey = 'audit.view';

/** Taking the filtered log away as a file (Phase D1). HIGH, owner-seeded; requires `audit.view`. */
export const AUDIT_EXPORT_PERMISSION: PermissionKey = 'audit.export';

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

  /**
   * Customer 360's timeline (§11.10): the rows recorded against ONE customer — as the
   * `Customer` entity (status, controls, trial override, reseller, transfer, manual order)
   * or as their `Wallet` (every adjustment) — newest first, with the reason the operator
   * gave. Through `audit_logs_entity_idx`, one probe per entity type.
   */
  customerTimeline(
    scope: TenantContext,
    customerId: string,
    limit: number,
  ): Promise<readonly (AuditHistoryRecord & { readonly reason: string | null })[]>;
}

/**
 * The audit log BROWSER (Phase D1, `docs/audit-log.md`) — the "different surface with its own
 * permission story" the paragraph above anticipated. `audit.view` to read, `audit.export` on
 * top to take a file. Like the entity reader it never selects `ip` or `user_agent`.
 */
export interface AuditLogFilter {
  /** `actor_id` is one of these. Resolved by the service from an id or a username. */
  readonly actorIds?: readonly string[];
  readonly actorType?: ActorType;
  /**
   * Rows about ONE customer: recorded against them (`Customer`, `Wallet`), or against an
   * order, payment or service that belongs to them.
   */
  readonly customerId?: string;
  readonly action?: { readonly exact: string } | { readonly prefix: string };
  readonly entityType?: string;
  readonly entityId?: string;
  readonly result?: AuditResult;
  readonly security?: AuditSecurityFilter;
  /**
   * Half-open: `from <= occurred_at < to`. Validated ISO text, compared in SQL as
   * `timestamptz` so a bound with microseconds is exact — a `Date` would truncate it.
   */
  readonly from?: string;
  readonly to?: string;
}

/**
 * Where a page ended. `occurredAt` is PostgreSQL's own microsecond text, never a `Date`, for
 * the reason `keyset-cursor.ts` gives: a millisecond `Date` sits BELOW its own row.
 */
export interface AuditLogPosition {
  readonly occurredAt: string;
  readonly id: string;
}

export interface AuditLogRecord extends AuditHistoryRecord {
  readonly actorId: string | null;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly reason: string | null;
  readonly correlationId: string;
  readonly position: AuditLogPosition;
}

/** The export's columns, in file order. Each has a Persian header in `@nexa/i18n`. */
export const AUDIT_EXPORT_COLUMNS = [
  'occurredAt',
  'actorType',
  'actorLabel',
  'actorId',
  'surface',
  'action',
  'entityType',
  'entityId',
  'result',
  'security',
  'reason',
  'before',
  'after',
  'correlationId',
  'id',
] as const;
export type AuditExportColumn = (typeof AUDIT_EXPORT_COLUMNS)[number];

/** Renders the export's rows to a file. Infrastructure, because the headers are Persian. */
export interface AuditLogExportWriter {
  csv(rows: readonly Readonly<Record<AuditExportColumn, string>>[]): Uint8Array;
}

export interface AuditLogReader {
  /**
   * At most `limit` rows, newest first by `(occurred_at, id)`, strictly after `after` in
   * that order. Another tenant's rows, and rows with no tenant, are never returned.
   */
  page(
    scope: TenantContext,
    filter: AuditLogFilter,
    limit: number,
    after: AuditLogPosition | null,
  ): Promise<readonly AuditLogRecord[]>;

  /** The ids of this tenant's administrators whose CURRENT username is this one. */
  adminIdsByUsername(scope: TenantContext, username: string): Promise<readonly string[]>;

  /**
   * The customer each of these customers, orders, payments and services belongs to, keyed
   * `Customer:<id>`, `Order:<id>` and so on — a customer belongs to itself. Ids that name
   * nothing in this tenant are simply absent.
   */
  ownersOf(
    scope: TenantContext,
    refs: {
      readonly customers: readonly string[];
      readonly orders: readonly string[];
      readonly payments: readonly string[];
      readonly services: readonly string[];
    },
  ): Promise<ReadonlyMap<string, string>>;
}
