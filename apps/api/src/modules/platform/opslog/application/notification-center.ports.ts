import type { NotificationRule, OperationalSeverity, TenantContext } from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';

/** One operational event as the inbox reads it, with this administrator's read mark. */
export interface InboxRow {
  readonly id: string;
  readonly code: string;
  readonly severity: OperationalSeverity;
  readonly message: string;
  readonly context: Record<string, unknown> | null;
  readonly occurrenceCount: number;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly resolvedAt: Date | null;
  readonly read: boolean;
}

/**
 * Which events, for one administrator: the rules of the categories they may see (already
 * narrowed by permission and by any category filter), and the window's start.
 */
export interface InboxFilter {
  readonly adminId: string;
  readonly rules: readonly NotificationRule[];
  readonly windowStart: Date;
  readonly unreadOnly: boolean;
}

export interface NotificationInboxRepository {
  /** Newest first by the IMMUTABLE `(first_seen_at, id)`, the operations log's own keyset. */
  list(
    scope: TenantContext,
    filter: InboxFilter,
    page: { readonly limit: number; readonly before: { at: Date; id: string } | null },
  ): Promise<readonly InboxRow[]>;
  /** One event, when it is in this administrator's filter; null otherwise. */
  find(
    scope: TenantContext,
    filter: InboxFilter,
    eventId: string,
    tx?: unknown,
  ): Promise<InboxRow | null>;
  /** Unread count (capped) and the highest unread severity. */
  unread(
    scope: TenantContext,
    filter: InboxFilter,
    cap: number,
  ): Promise<{ readonly count: number; readonly highest: OperationalSeverity | null }>;
  /**
   * Read: `read_through` becomes the event's CURRENT `last_seen_at`, read in the same
   * statement. Unread: `read_through` becomes NULL. A set, so a repeat is the same state.
   */
  mark(
    scope: TenantContext,
    adminId: string,
    eventId: string,
    read: boolean,
    now: Date,
    tx: TransactionScope,
  ): Promise<void>;
  /** Every UNREAD event in the filter marked read through its current last-seen. */
  markAll(
    scope: TenantContext,
    filter: InboxFilter,
    now: Date,
    tx: TransactionScope,
  ): Promise<number>;
}
