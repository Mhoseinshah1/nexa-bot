import type { Readable } from 'node:stream';
import type { DataExportState, TenantContext } from '@nexa/contracts';

/** One `tenant_data_exports` row. */
export interface DataExportRow {
  readonly id: string;
  /** The EXPORTED tenant. */
  readonly tenantId: string;
  readonly state: DataExportState;
  readonly requestedByAdminId: string;
  readonly requestedByHost: boolean;
  readonly requestedAt: Date;
  readonly leaseOwner: string | null;
  readonly heartbeatAt: Date | null;
  readonly attempts: number;
  readonly fileName: string | null;
  readonly bytes: number | null;
  readonly sha256: string | null;
  readonly readyAt: Date | null;
  readonly expiresAt: Date | null;
  readonly removedAt: Date | null;
  readonly failureCode: string | null;
  readonly updatedAt: Date;
}

/**
 * The export requests. Tenant-scoped methods take the exported tenant's scope; the three
 * with no scope (`claimNext`, `failAbandoned`, `expireDue`, `pendingRemoval`) are the worker's
 * cross-tenant sweeps, on the system path under their own pinned reasons.
 */
export interface DataExportRepository {
  insert(
    scope: TenantContext,
    row: {
      readonly id: string;
      readonly requestedByAdminId: string;
      readonly requestedByHost: boolean;
      readonly now: Date;
    },
    tx?: unknown,
  ): Promise<void>;
  find(scope: TenantContext, id: string, tx?: unknown): Promise<DataExportRow | null>;
  /** Newest first. */
  list(
    scope: TenantContext,
    limit: number,
    tx?: unknown,
    filter?: { readonly requestedByHost?: boolean },
  ): Promise<DataExportRow[]>;
  /** The export being made for this tenant, if any. */
  active(scope: TenantContext, tx?: unknown): Promise<DataExportRow | null>;

  // --- the worker -----------------------------------------------------------------------
  /** The oldest REQUESTED (or abandoned RUNNING) export, claimed for `leaseOwner`. */
  claimNext(input: {
    readonly now: Date;
    readonly staleBefore: Date;
    readonly leaseOwner: string;
    readonly maxAttempts: number;
  }): Promise<DataExportRow | null>;
  /** RUNNING exports whose lease went stale and that used every attempt: FAILED. */
  failAbandoned(input: {
    readonly now: Date;
    readonly staleBefore: Date;
    readonly maxAttempts: number;
  }): Promise<number>;
  heartbeat(
    scope: TenantContext,
    input: { readonly id: string; readonly leaseOwner: string; readonly now: Date },
  ): Promise<boolean>;
  /** RUNNING → READY, only for the lease holder. */
  markReady(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly leaseOwner: string;
      readonly fileName: string;
      readonly bytes: number;
      readonly sha256: string;
      readonly now: Date;
      readonly expiresAt: Date;
    },
  ): Promise<boolean>;
  /** RUNNING → FAILED, only for the lease holder. */
  markFailed(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly leaseOwner: string;
      readonly failureCode: string;
      readonly now: Date;
    },
  ): Promise<boolean>;
  /** RUNNING → REQUESTED: the queue did not admit it this time. */
  release(
    scope: TenantContext,
    input: { readonly id: string; readonly leaseOwner: string; readonly now: Date },
  ): Promise<boolean>;
  /** READY exports past their deadline: EXPIRED. Their files are removed by the caller. */
  expireDue(now: Date): Promise<number>;
  /** EXPIRED exports whose file has not been removed yet. */
  pendingRemoval(limit: number): Promise<DataExportRow[]>;
  markRemoved(scope: TenantContext, id: string, now: Date): Promise<void>;
  /** The state and published file of each of these exports (a missing id is not returned). */
  statesOf(
    ids: readonly string[],
  ): Promise<
    { readonly id: string; readonly state: DataExportState; readonly fileName: string | null }[]
  >;
}

/** The export files on disk: `<root>/<tenantId>/<fileName>`, never a caller's path. */
export interface DataExportFiles {
  /**
   * The path the worker writes for one ATTEMPT of one export of one tenant. The attempt is in
   * the name, so a worker that lost its lease and the one that took the export over never
   * write, publish or delete the same file.
   */
  pathFor(
    tenantId: string,
    exportId: string,
    attempt: number,
  ): { readonly path: string; readonly fileName: string };
  /** Every export file (and `.part`) on disk, for the debris sweep. */
  list(): Promise<
    { readonly tenantId: string; readonly fileName: string; readonly exportId: string }[]
  >;
  open(
    tenantId: string,
    fileName: string,
  ): Promise<{ readonly stream: Readable; readonly bytes: number } | null>;
  remove(tenantId: string, fileName: string): Promise<void>;
}

/** The ZIP's writer, as the worker uses it (`writeDataExport`). */
export interface DataExportWriter {
  write(input: {
    readonly tenantId: string;
    readonly path: string;
    readonly generatedAt: Date;
  }): Promise<{ readonly bytes: number; readonly sha256: string }>;
}

/** The heavy-job queue (`HeavyJobGate`), as the worker uses it. */
export interface DataExportQueue {
  runWhenAdmitted<T>(
    kind: 'EXPORT',
    tenantId: string,
    job: () => Promise<T>,
    options: {
      readonly pollMs: number;
      readonly maxWaitMs: number;
      readonly sleep: (ms: number) => Promise<void>;
    },
  ): Promise<{ readonly ran: true; readonly result: T } | { readonly ran: false }>;
}

/** What the service asks of the hosted-bot register: is this tenant a hosted bot of ours. */
export interface HostedBotLookup {
  findHosted(
    installation: TenantContext,
    hostedTenantId: string,
    tx?: unknown,
    lock?: boolean,
  ): Promise<{ readonly state: string } | null>;
}
