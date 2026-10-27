import {
  USAGE_SNAPSHOT_BUCKET_MINUTES,
  USAGE_SNAPSHOT_RETENTION_DAYS,
  type Clock,
  type TenantContext,
  type UsageChartRangeDays,
} from '@nexa/contracts';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { FeatureFlagResolver } from '../../../control/features/application/feature-flags.service.js';

/**
 * R11 B2 -- the usage snapshots behind the mini app's chart.
 *
 * THE RULE THIS FILE EXISTS FOR: a snapshot is recorded BESIDE a usage read that already
 * happens and is never the reason for one. `record` is called from the three places that
 * already write a panel's usage figure (`ServiceRepository.recordUsage`: the scheduled
 * `SYNC_USAGE`, a renewal whose answer carries usage, a card's live check) and takes the
 * figure THEY hold. It has no panel client, no probe budget and no loop; RickPanel's load is
 * exactly what it was before. The cadence the chart gets is therefore the cadence of those
 * reads -- `provisioning.usage_sync_minutes` (four hours by default) plus whatever live checks
 * customers cause -- thinned to at most one row per service per hour by the table's key.
 */

/** One stored figure, as the chart reads it. */
export interface UsageSnapshotRow {
  readonly takenAt: Date;
  readonly usedBytes: bigint;
  readonly totalBytes: bigint | null;
  readonly expiresAt: Date | null;
}

export interface UsageSnapshotStore {
  /**
   * Inserts the snapshot of an ACTIVE service for `bucketAt`, taking its allowance and deadline
   * from the service row, and does nothing when that bucket already has one. Reports whether a
   * row was written.
   */
  record(
    scope: TenantContext,
    serviceId: string,
    snapshot: { readonly usedBytes: bigint; readonly takenAt: Date; readonly bucketAt: Date },
    tx: TransactionScope,
  ): Promise<boolean>;
  /** Deletes up to `limit` rows taken before `before`; returns how many went. */
  prune(scope: TenantContext, before: Date, limit: number, tx: TransactionScope): Promise<number>;
  /** The service's rows with `bucket_at` in `[from, to)`, oldest first. */
  between(
    scope: TenantContext,
    serviceId: string,
    from: Date,
    to: Date,
    limit: number,
    tx?: unknown,
  ): Promise<readonly UsageSnapshotRow[]>;
}

export interface UsageHistory {
  readonly days: UsageChartRangeDays;
  readonly from: Date;
  readonly to: Date;
  readonly points: readonly { readonly at: Date; readonly usedBytes: bigint }[];
  readonly totalBytes: bigint | null;
  readonly expiresAt: Date | null;
}

export interface UsageSnapshotDeps {
  readonly store: UsageSnapshotStore;
  readonly features: Pick<FeatureFlagResolver, 'isEnabled'>;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
}

const BUCKET_MS = USAGE_SNAPSHOT_BUCKET_MINUTES * 60_000;
const RETENTION_MS = USAGE_SNAPSHOT_RETENTION_DAYS * 86_400_000;
/** A tick deletes at most this many rows: the work stays small whatever the backlog. */
export const USAGE_SNAPSHOT_PRUNE_BATCH = 500;
/** 30 days of hourly buckets is 720; the cap only guards a corrupted table. */
const HISTORY_ROW_CAP = 1000;

/** `at` floored to its bucket (UTC, whole hours since the epoch). */
export function usageBucketOf(at: Date): Date {
  return new Date(Math.floor(at.getTime() / BUCKET_MS) * BUCKET_MS);
}

export class UsageSnapshotService {
  constructor(private readonly deps: UsageSnapshotDeps) {}

  /**
   * Called INSIDE the transaction that wrote the usage figure, after `recordUsage` reported it
   * moved the row. Writes nothing when the flag is off or the tenant has stopped. The figure
   * recorded is the one the panel returned, and `at` is the instant that write used.
   */
  async record(
    scope: TenantContext,
    serviceId: string,
    usage: { readonly usedBytes: bigint; readonly at: Date },
    tx: TransactionScope,
  ): Promise<boolean> {
    if (!(await this.deps.features.isEnabled(scope, 'service_usage_chart', tx))) return false;
    if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return false;
    return this.deps.store.record(
      scope,
      serviceId,
      { usedBytes: usage.usedBytes, takenAt: usage.at, bucketAt: usageBucketOf(usage.at) },
      tx,
    );
  }

  /**
   * Retention, run from the provisioner's tick whatever the flag says -- snapshots stored
   * before the flag went off still expire. Bounded, and only for a tenant that is running.
   */
  async prune(scope: TenantContext, tx: TransactionScope): Promise<number> {
    if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return 0;
    const before = new Date(this.deps.clock.now().getTime() - RETENTION_MS);
    return this.deps.store.prune(scope, before, USAGE_SNAPSHOT_PRUNE_BATCH, tx);
  }

  /** Whether the chart is on: what the service screen asks before it draws one. */
  chartEnabled(scope: TenantContext): Promise<boolean> {
    return this.deps.features.isEnabled(scope, 'service_usage_chart');
  }

  /**
   * The chart's data for ONE service the caller has already proved is the customer's own
   * (`ProvisioningService.getForCustomer`), or `null` when the flag is off: the surface then
   * answers as if the route did not exist.
   */
  async history(
    scope: TenantContext,
    serviceId: string,
    days: UsageChartRangeDays,
  ): Promise<UsageHistory | null> {
    if (!(await this.chartEnabled(scope))) return null;
    const to = this.deps.clock.now();
    const from = new Date(to.getTime() - days * 86_400_000);
    const rows = await this.deps.store.between(scope, serviceId, from, to, HISTORY_ROW_CAP);
    const newest = rows.at(-1) ?? null;
    return {
      days,
      from,
      to,
      points: rows.map((row) => ({ at: row.takenAt, usedBytes: row.usedBytes })),
      totalBytes: newest?.totalBytes ?? null,
      expiresAt: newest?.expiresAt ?? null,
    };
  }
}
