import type {
  CustomerNotificationState,
  CustomerStatus,
  DirectMessageContentKind,
  DirectMessageFileMimeType,
  TenantContext,
  TicketAttachmentKind,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';

/** A direct message's file as stored: metadata always, bytes only while staged. */
export interface DirectMessageFileRecord {
  readonly kind: TicketAttachmentKind;
  readonly mimeType: DirectMessageFileMimeType;
  readonly fileName: string;
  readonly byteLength: number;
  readonly sha256: string;
  /** Whether the bytes are still here (not yet taken by Telegram, not yet retained away). */
  readonly staged: boolean;
}

/** The message row, as the application reads it. */
export interface DirectMessageRecord {
  readonly id: string;
  readonly customerId: string;
  readonly botInstanceId: string;
  readonly authorAdminId: string;
  readonly contentKind: DirectMessageContentKind;
  /** The text of a TEXT message, or a file's caption; null for a file without one. */
  readonly body: string | null;
  readonly file: DirectMessageFileRecord | null;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly createdAt: Date;
}

/** One history row: the message, who wrote it and where its lane row is. */
export interface DirectMessageHistoryRow {
  readonly message: DirectMessageRecord;
  readonly authorUsername: string | null;
  /** The lane row; null only if it is missing, which the projection reads as FAILED. */
  readonly lane: {
    readonly state: CustomerNotificationState;
    readonly sendStarted: boolean;
    readonly attempts: number;
    readonly resolvedAt: Date | null;
  } | null;
}

/** What send-time revalidation reads about the target, under the customer's row lock. */
export interface DirectMessageTarget {
  readonly customerId: string;
  readonly status: CustomerStatus;
  /** The customer's own bot, when it exists and is ACTIVE; null otherwise. */
  readonly activeBotInstanceId: string | null;
}

export interface DirectMessageDraft {
  readonly id: string;
  readonly customerId: string;
  readonly botInstanceId: string;
  readonly authorAdminId: string;
  readonly contentKind: DirectMessageContentKind;
  readonly body: string | null;
  readonly file: {
    readonly mimeType: DirectMessageFileMimeType;
    readonly fileName: string;
    readonly bytes: Uint8Array;
    readonly sha256: string;
  } | null;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly now: Date;
}

export interface DirectMessageRepository {
  /**
   * The tenant's direct-message lock (transaction-scoped advisory lock), taken FIRST by every
   * send: it serialises the rate-limit counts, the staging bound and the idempotency lookup,
   * so two concurrent sends cannot each pass a count and together cross it.
   */
  lockTenant(scope: TenantContext, tx: TransactionScope): Promise<void>;
  /** Whether the customer is this tenant's — the history's isolation check. */
  customerExists(scope: TenantContext, customerId: string): Promise<boolean>;
  /**
   * The target, read `FOR SHARE` so a block committing concurrently either is seen or waits
   * for this send to commit. Null when the customer is not this tenant's.
   */
  target(
    scope: TenantContext,
    customerId: string,
    tx: TransactionScope,
  ): Promise<DirectMessageTarget | null>;
  findByKey(
    scope: TenantContext,
    idempotencyKey: string,
    tx: TransactionScope,
  ): Promise<DirectMessageRecord | null>;
  /** Messages by this administrator in `[since, now]` — the per-operator window. */
  countByAdminSince(
    scope: TenantContext,
    adminId: string,
    since: Date,
    tx: TransactionScope,
  ): Promise<number>;
  /** Messages to this customer in `[since, now]` — the per-customer window. */
  countByCustomerSince(
    scope: TenantContext,
    customerId: string,
    since: Date,
    tx: TransactionScope,
  ): Promise<number>;
  /** Bytes the tenant holds undelivered. */
  stagedBytes(scope: TenantContext, tx: TransactionScope): Promise<number>;
  insert(scope: TenantContext, draft: DirectMessageDraft, tx: TransactionScope): Promise<void>;
  find(scope: TenantContext, id: string, tx?: unknown): Promise<DirectMessageRecord | null>;
  /** The staged bytes, or null when they are gone. */
  fileContent(scope: TenantContext, id: string): Promise<Uint8Array | null>;
  /** Telegram took the file: its handle stamped, the bytes cleared. Never overwrites a handle. */
  markFileDelivered(
    scope: TenantContext,
    id: string,
    file: { readonly fileId: string; readonly fileUniqueId: string },
    at: Date,
    tx: TransactionScope,
  ): Promise<boolean>;
  /** Retention: clears bytes older than `cutoff`, oldest first, across tenants. */
  purgeFileContentBefore(cutoff: Date, at: Date, limit: number): Promise<number>;
  /** The customer's messages, newest first, by `(created_at, id)` keyset. */
  history(
    scope: TenantContext,
    customerId: string,
    input: {
      readonly limit: number;
      readonly before: { readonly at: Date; readonly id: string } | null;
    },
  ): Promise<readonly DirectMessageHistoryRow[]>;
  historyRow(scope: TenantContext, id: string): Promise<DirectMessageHistoryRow | null>;
}
