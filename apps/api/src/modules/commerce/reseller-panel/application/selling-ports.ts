import type { ResellerDailyReportKind, TenantContext } from '@nexa/contracts';

/** One «خرید» of N services, as stored (PR-5 §5.5). It groups; it never decides money. */
export interface PurchaseBatchRecord {
  readonly id: string;
  readonly customerId: string;
  readonly idempotencyKey: string;
  readonly productId: string | null;
  readonly customPanelId: string | null;
  readonly customVolumeUnits: bigint | null;
  readonly customDays: number | null;
  readonly title: string;
  readonly quantity: number;
  readonly usernameMode: 'AUTOMATIC' | 'CUSTOM';
  readonly customUsername: string | null;
  readonly clientId: string | null;
  readonly note: string | null;
  readonly createdAt: Date;
  readonly confirmedAt: Date | null;
}

export interface PurchaseBatchOrderRecord {
  readonly position: number;
  readonly orderId: string;
  readonly appliedAt: Date | null;
}

/** A batch order whose service now exists and has not had the batch's client/note put on it. */
export interface PendingBatchApplication {
  readonly batchId: string;
  readonly position: number;
  readonly serviceId: string;
  readonly clientId: string | null;
  readonly note: string | null;
}

export interface ResellerClientRecord {
  readonly id: string;
  readonly customerId: string;
  readonly name: string;
  readonly contact: string | null;
  readonly note: string | null;
  readonly createdAt: Date;
  readonly archivedAt: Date | null;
}

export interface ResellerTierTargetRecord {
  readonly tierId: string;
  readonly kind: 'COUNT' | 'AMOUNT';
  readonly count: number | null;
  readonly amountMinor: bigint | null;
  readonly currency: string | null;
}

/**
 * PR-5 — the selling half's rows. EVERY read and write of a batch or a client names the owning
 * reseller (`customerId`): another reseller's id is simply not found. `tx` is the caller's
 * transaction; methods without one read on the pool.
 */
export interface ResellerSellingRepository {
  // --- purchase batches ----------------------------------------------------------------
  findBatchByKey(
    scope: TenantContext,
    customerId: string,
    idempotencyKey: string,
    tx?: unknown,
  ): Promise<PurchaseBatchRecord | null>;
  findBatch(
    scope: TenantContext,
    customerId: string,
    batchId: string,
    tx?: unknown,
  ): Promise<PurchaseBatchRecord | null>;
  /** Inserts the batch; false when one with this key already exists (the caller re-reads). */
  insertBatch(
    scope: TenantContext,
    row: Omit<PurchaseBatchRecord, 'confirmedAt'>,
    tx: unknown,
  ): Promise<boolean>;
  insertBatchOrder(
    scope: TenantContext,
    row: {
      readonly batchId: string;
      readonly position: number;
      readonly orderId: string;
      readonly customerId: string;
    },
    tx?: unknown,
  ): Promise<void>;
  batchOrders(
    scope: TenantContext,
    batchId: string,
    tx?: unknown,
  ): Promise<readonly PurchaseBatchOrderRecord[]>;
  /** `confirmed_at` set once; false when it already was. */
  markBatchConfirmed(
    scope: TenantContext,
    input: { readonly batchId: string; readonly customerId: string; readonly now: Date },
    tx: unknown,
  ): Promise<boolean>;
  pendingApplications(
    scope: TenantContext,
    customerId: string,
  ): Promise<readonly PendingBatchApplication[]>;
  markApplied(
    scope: TenantContext,
    input: { readonly batchId: string; readonly position: number; readonly now: Date },
    tx: unknown,
  ): Promise<boolean>;

  // --- clients book --------------------------------------------------------------------
  listClients(
    scope: TenantContext,
    customerId: string,
    query: { readonly archived: boolean; readonly q?: string },
  ): Promise<readonly ResellerClientRecord[]>;
  findClient(
    scope: TenantContext,
    customerId: string,
    clientId: string,
    tx?: unknown,
  ): Promise<ResellerClientRecord | null>;
  insertClient(
    scope: TenantContext,
    row: {
      readonly id: string;
      readonly customerId: string;
      readonly name: string;
      readonly contact: string | null;
      readonly note: string | null;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<void>;
  updateClient(
    scope: TenantContext,
    row: {
      readonly id: string;
      readonly customerId: string;
      readonly name: string;
      readonly contact: string | null;
      readonly note: string | null;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean>;
  archiveClient(
    scope: TenantContext,
    input: { readonly id: string; readonly customerId: string; readonly now: Date },
    tx: unknown,
  ): Promise<boolean>;
  /** serviceId → clientId, for the reseller's assignments (the service's owner is not read). */
  assignmentsOf(scope: TenantContext, customerId: string): Promise<ReadonlyMap<string, string>>;
  assignedTo(scope: TenantContext, serviceId: string, tx?: unknown): Promise<string | null>;
  assign(
    scope: TenantContext,
    row: {
      readonly serviceId: string;
      readonly clientId: string;
      readonly customerId: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<void>;
  unassign(
    scope: TenantContext,
    input: { readonly serviceId: string; readonly customerId: string },
    tx: unknown,
  ): Promise<boolean>;

  // --- daily reports and tier targets --------------------------------------------------
  /** Inserts the day's report; null when this reseller already has this kind for this day. */
  insertDailyReport(
    scope: TenantContext,
    row: {
      readonly id: string;
      readonly customerId: string;
      readonly kind: ResellerDailyReportKind;
      readonly day: string;
      readonly facts: Record<string, unknown>;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<string | null>;
  findTierTarget(scope: TenantContext, tierId: string): Promise<ResellerTierTargetRecord | null>;
  saveTierTarget(
    scope: TenantContext,
    input: {
      readonly tierId: string;
      readonly target: Omit<ResellerTierTargetRecord, 'tierId'> | null;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<void>;
}
