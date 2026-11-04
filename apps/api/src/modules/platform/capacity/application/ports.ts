import type {
  CapacityLimit,
  CapacityResource,
  HeavyJobKind,
  OperationalEventInput,
  ScopeContext,
  TenantStatus,
} from '@nexa/contracts';

/** The owner's stored limits (`tenant_capacity_limits`). Absent rows are tier defaults. */
export interface CapacityLimitRepository {
  /** Every stored limit of one tenant. */
  storedFor(tenantId: string, tx?: unknown): Promise<ReadonlyMap<CapacityResource, CapacityLimit>>;
  /** Every stored limit of every tenant, by tenant. The owner's list. */
  storedForAll(
    tx?: unknown,
  ): Promise<ReadonlyMap<string, ReadonlyMap<CapacityResource, CapacityLimit>>>;
  /**
   * Stores `limit` (or deletes the row for `null`) and answers what was stored before.
   * Inside the caller's transaction, under the row's lock.
   */
  put(
    input: {
      readonly tenantId: string;
      readonly resource: CapacityResource;
      readonly limit: CapacityLimit | null;
      readonly now: Date;
      readonly adminId: string | null;
    },
    tx: unknown,
  ): Promise<CapacityLimit | null>;
}

export interface CapacityTenantRow {
  readonly id: string;
  readonly displayName: string;
  readonly status: TenantStatus;
}

/** The tenants the owner's list names. */
export interface CapacityTenantDirectory {
  all(tx?: unknown): Promise<readonly CapacityTenantRow[]>;
  find(tenantId: string, tx?: unknown): Promise<CapacityTenantRow | null>;
}

/** Records an operational event on the INSTALLATION tenant: the owner's group, nobody else's. */
export interface OwnerOpsLog {
  record(event: OperationalEventInput): Promise<void>;
  conditionOpen(code: string): Promise<boolean>;
}

/** What the server has left. Each answers null when it cannot tell. */
export interface SystemProbe {
  availableMemoryBytes(): Promise<number | null>;
  /** The volume holding `path`, in bytes. */
  disk(
    path: string,
  ): Promise<{ readonly totalBytes: number; readonly availableBytes: number } | null>;
}

export interface HeavyJobTicket {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: HeavyJobKind;
  readonly state: 'QUEUED' | 'RUNNING' | 'DONE' | 'ABANDONED';
}

/** The installation-wide heavy-job queue (`heavy_job_tickets`). */
export interface HeavyJobQueueRepository {
  enqueue(input: {
    readonly id: string;
    readonly tenantId: string;
    readonly kind: HeavyJobKind;
    readonly priority: number;
    readonly now: Date;
    readonly leaseUntil: Date;
  }): Promise<void>;
  /**
   * Under one installation-wide lock: abandons every live ticket whose lease ran out, then
   * starts `id` when it is first in the queue (priority, then arrival) and fewer than
   * `concurrency` run. Refreshes the ticket's lease either way. Answers its state after.
   */
  tryStart(
    id: string,
    input: { readonly now: Date; readonly leaseUntil: Date; readonly concurrency: number },
  ): Promise<HeavyJobTicket['state'] | null>;
  /** Pushes a RUNNING or QUEUED ticket's lease out. */
  heartbeat(id: string, leaseUntil: Date): Promise<void>;
  finish(id: string, now: Date): Promise<void>;
  /** Deletes finished tickets older than `before`. */
  purgeFinished(before: Date): Promise<number>;
}

/** The scope the capacity guards act in when no request names one. */
export type InstallationScope = () => ScopeContext | null;
