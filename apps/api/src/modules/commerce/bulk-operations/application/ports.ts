import type {
  AudienceDefinition,
  BulkCounts,
  BulkItemState,
  BulkOperationKind,
  BulkOperationState,
  BulkSkipReason,
  CurrencyCode,
  CustomerNotificationState,
  TenantContext,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { AudienceEvaluation } from '../../audience/infrastructure/audience-sql.js';

export interface BulkOperationRecord {
  readonly id: string;
  readonly kind: BulkOperationKind;
  readonly state: BulkOperationState;
  readonly amountMinor: bigint | null;
  readonly currency: CurrencyCode | null;
  readonly trafficBytes: bigint | null;
  readonly durationDays: number | null;
  readonly notify: boolean;
  readonly note: string;
  readonly audienceDefinition: AudienceDefinition;
  readonly audienceHash: string;
  readonly audienceAsOf: Date;
  readonly itemCount: number;
  readonly audienceFingerprint: string;
  readonly notBefore: Date | null;
  /** Round N close (§A): the frozen audience the items were copied from; null when live. */
  readonly frozenAudienceId: string | null;
  readonly createdBy: { readonly id: string; readonly username: string } | null;
  readonly createdAt: Date;
  /** Round N close (§B): set while PAUSED. */
  readonly pausedAt: Date | null;
  readonly completedAt: Date | null;
  readonly cancelledAt: Date | null;
}

export interface BulkOperationDraft {
  readonly id: string;
  readonly kind: BulkOperationKind;
  readonly amountMinor: bigint | null;
  readonly currency: CurrencyCode | null;
  readonly trafficBytes: bigint | null;
  readonly durationDays: number | null;
  readonly notify: boolean;
  readonly note: string;
  readonly audienceJson: string;
  readonly audienceHash: string;
  readonly audienceAsOf: Date;
  readonly itemCount: number;
  readonly fingerprint: string;
  readonly notBefore: Date | null;
  readonly frozenAudienceId: string | null;
  readonly createdByAdminId: string;
  readonly now: Date;
}

/** Which services a traffic or time grant may reach, beyond the audience's own block. */
export interface GrantEligibility {
  readonly kind: 'SERVICE_TRAFFIC' | 'SERVICE_TIME';
  /** Panels on which the operation is operable now; a service elsewhere is not counted. */
  readonly operablePanelIds: readonly string[];
}

/** What a materialisation (or its preview) froze. */
export interface FrozenItems {
  readonly count: number;
  readonly customers: number;
  /** md5 over the sorted subject ids: customers for a credit, services for a grant. */
  readonly fingerprint: string;
}

export interface BulkSampleRow {
  readonly customerId: string;
  readonly firstName: string | null;
  readonly username: string | null;
  readonly serviceId: string | null;
  readonly serviceLabel: string | null;
}

/** One item locked for processing, with what its operation grants. */
export interface LockedItem {
  readonly id: string;
  readonly operationId: string;
  readonly customerId: string;
  readonly serviceId: string | null;
  readonly kind: BulkOperationKind;
  readonly amountMinor: bigint | null;
  readonly currency: CurrencyCode | null;
  readonly trafficBytes: bigint | null;
  readonly durationDays: number | null;
  readonly notify: boolean;
  readonly note: string;
  readonly createdByAdminId: string;
  /** Whether the audience asked for ACTIVE customers only (a live re-check). */
  readonly requiresActiveCustomer: boolean;
}

export interface BulkItemPageRow {
  readonly id: string;
  readonly customerId: string;
  readonly firstName: string | null;
  readonly username: string | null;
  readonly serviceId: string | null;
  readonly serviceLabel: string | null;
  readonly state: BulkItemState;
  readonly skipReason: BulkSkipReason | null;
  readonly operationState: string | null;
  readonly failureKind: string | null;
  /** The lane DELIVERED the notice — not merely enqueued it. */
  readonly notified: boolean;
  readonly notificationState: CustomerNotificationState | null;
  readonly processedAt: Date | null;
}

export interface BulkOperationRepository {
  create(scope: TenantContext, draft: BulkOperationDraft, tx: TransactionScope): Promise<void>;
  find(scope: TenantContext, id: string, tx?: unknown): Promise<BulkOperationRecord | null>;
  lock(scope: TenantContext, id: string, tx: TransactionScope): Promise<BulkOperationRecord | null>;
  list(
    scope: TenantContext,
    limit: number,
    cursor: { readonly createdAt: Date; readonly id: string } | null,
  ): Promise<readonly BulkOperationRecord[]>;
  counts(scope: TenantContext, ids: readonly string[]): Promise<ReadonlyMap<string, BulkCounts>>;
  creditedTotals(
    scope: TenantContext,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, bigint>>;
  items(
    scope: TenantContext,
    id: string,
    input: {
      readonly state: BulkItemState | null;
      readonly limit: number;
      readonly after: string | null;
    },
  ): Promise<readonly BulkItemPageRow[]>;

  /** The distinct panels the audience's eligible-by-state services live on. */
  panelsFor(
    scope: TenantContext,
    evaluation: AudienceEvaluation,
    kind: 'SERVICE_TRAFFIC' | 'SERVICE_TIME',
    tx?: unknown,
  ): Promise<readonly string[]>;
  previewServices(
    scope: TenantContext,
    evaluation: AudienceEvaluation,
    eligibility: GrantEligibility,
    sampleSize: number,
  ): Promise<FrozenItems & { readonly sample: readonly BulkSampleRow[] }>;
  sampleCustomers(
    scope: TenantContext,
    evaluation: AudienceEvaluation,
    sampleSize: number,
  ): Promise<readonly BulkSampleRow[]>;
  materialiseCustomers(
    scope: TenantContext,
    id: string,
    evaluation: AudienceEvaluation,
    now: Date,
    tx: TransactionScope,
  ): Promise<FrozenItems>;
  materialiseServices(
    scope: TenantContext,
    id: string,
    evaluation: AudienceEvaluation,
    eligibility: GrantEligibility,
    now: Date,
    tx: TransactionScope,
  ): Promise<FrozenItems>;

  /**
   * Round N close (§A): the items copied from a FROZEN audience's member rows — customers
   * for a wallet credit, `(customer, service)` for a grant — with the count and fingerprint
   * of the rows written, for the caller to compare with the frozen header.
   */
  materialiseFromFrozen(
    scope: TenantContext,
    id: string,
    frozenAudienceId: string,
    kind: BulkOperationKind,
    now: Date,
    tx: TransactionScope,
  ): Promise<FrozenItems>;
  /**
   * Round N close (§A): writes a SERVICES frozen audience's member rows — the services the
   * audience's block selects that are eligible for the grant NOW, by the same query the
   * preview and the live materialisation use.
   */
  freezeServiceMembers(
    scope: TenantContext,
    frozenAudienceId: string,
    evaluation: AudienceEvaluation,
    eligibility: GrantEligibility,
    tx: TransactionScope,
  ): Promise<void>;

  /** Cancels a RUNNING or PAUSED operation and every PENDING item. False when it had ended. */
  cancel(scope: TenantContext, id: string, now: Date, tx: TransactionScope): Promise<boolean>;
  /** Round N close (§B): one conditional edge of `BULK_OPERATION_MACHINE`, naming its `from` states. */
  transition(
    scope: TenantContext,
    id: string,
    from: readonly BulkOperationState[],
    to: 'RUNNING' | 'PAUSED',
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean>;

  // --- the processor's half -----------------------------------------------------------
  /**
   * The next PENDING item of a RUNNING operation whose `not_before` has passed, locked
   * `FOR UPDATE SKIP LOCKED` in the caller's transaction. The gate is in the query itself.
   */
  lockNextPending(
    scope: TenantContext,
    now: Date,
    /** Items that already failed unexpectedly in this pass, so one cannot hold the rest. */
    exclude: readonly string[],
    tx: TransactionScope,
  ): Promise<LockedItem | null>;
  markCredited(
    scope: TenantContext,
    itemId: string,
    walletEntryId: string,
    now: Date,
    tx: TransactionScope,
  ): Promise<void>;
  markPlanned(
    scope: TenantContext,
    itemId: string,
    provisioningOperationRowId: string,
    now: Date,
    tx: TransactionScope,
  ): Promise<void>;
  markSkipped(
    scope: TenantContext,
    itemId: string,
    reason: BulkSkipReason,
    now: Date,
    tx: TransactionScope,
  ): Promise<void>;
  /** Stamps the instant the item's notice was ENQUEUED; delivery is the lane's to report. */
  markNotified(
    scope: TenantContext,
    itemId: string,
    now: Date,
    tx: TransactionScope,
  ): Promise<void>;
  /**
   * PLANNED items whose provisioning operation reached an AUTHORITATIVE end, moved to
   * SUCCEEDED or FAILED. An UNKNOWN operation leaves its item PLANNED until reconciliation
   * decides it.
   */
  settlePlanned(
    scope: TenantContext,
    now: Date,
    limit: number,
    tx: TransactionScope,
  ): Promise<
    readonly {
      readonly itemId: string;
      readonly customerId: string;
      readonly to: 'SUCCEEDED' | 'FAILED';
      readonly notify: boolean;
    }[]
  >;
  completeFinished(
    scope: TenantContext,
    now: Date,
    tx: TransactionScope,
  ): Promise<readonly { readonly id: string; readonly kind: string; readonly items: number }[]>;
  customerStatus(
    scope: TenantContext,
    customerId: string,
    tx: TransactionScope,
  ): Promise<string | null>;

  /** What a mass-action notification renders, read from the item it names. */
  notificationValues(
    scope: TenantContext,
    kind: 'WALLET_MASS_CREDITED' | 'SERVICE_GIFT_APPLIED',
    itemId: string,
  ): Promise<{
    readonly amountMinor: bigint | null;
    readonly currency: CurrencyCode | null;
    readonly serviceLabel: string | null;
    readonly trafficBytes: bigint | null;
    readonly durationDays: number | null;
  } | null>;
}
