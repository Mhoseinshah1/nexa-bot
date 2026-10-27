import { sql } from 'drizzle-orm';
import type { TenantContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type { UsageSnapshotRow, UsageSnapshotStore } from '../application/usage-snapshots.js';

/**
 * R11 B2: `service_usage_snapshots`. Never a panel call -- it only stores what a caller holds.
 */
export class DrizzleUsageSnapshotRepository implements UsageSnapshotStore {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  /**
   * One INSERT ... SELECT from the service row: the allowance and deadline are the row's own at
   * this moment, and nothing is written for a service that is not ACTIVE (the figure it would
   * record was refused by `recordUsage`'s own condition). `ON CONFLICT DO NOTHING` on the
   * bucket's key is the dedupe: the first figure of an hour stays, a later one is dropped.
   */
  async record(
    scope: TenantContext,
    serviceId: string,
    snapshot: { readonly usedBytes: bigint; readonly takenAt: Date; readonly bucketAt: Date },
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const result = await this.exec(tx).execute(sql`
      INSERT INTO service_usage_snapshots (tenant_id, service_id, bucket_at, taken_at,
                                           used_bytes, total_bytes, expires_at)
      SELECT s.tenant_id, s.id, ${snapshot.bucketAt}, ${snapshot.takenAt}, ${snapshot.usedBytes},
             NULLIF(s.traffic_limit_bytes, 0), s.expires_at
        FROM services s
       WHERE s.tenant_id = ${tenantId} AND s.id = ${serviceId} AND s.state = 'ACTIVE'
      ON CONFLICT (tenant_id, service_id, bucket_at) DO NOTHING
      RETURNING service_id
    `);
    return result.rows.length === 1;
  }

  async prune(
    scope: TenantContext,
    before: Date,
    limit: number,
    tx: TransactionScope,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    const result = await this.exec(tx).execute(sql`
      DELETE FROM service_usage_snapshots
       WHERE ctid IN (SELECT ctid FROM service_usage_snapshots
                       WHERE tenant_id = ${tenantId} AND taken_at < ${before}
                       LIMIT ${limit})
      RETURNING service_id
    `);
    return result.rows.length;
  }

  async between(
    scope: TenantContext,
    serviceId: string,
    from: Date,
    to: Date,
    limit: number,
    tx?: unknown,
  ): Promise<readonly UsageSnapshotRow[]> {
    const tenantId = requireTenantId(scope);
    const result = await this.exec(tx).execute(sql`
      SELECT taken_at, used_bytes, total_bytes, expires_at
        FROM service_usage_snapshots
       WHERE tenant_id = ${tenantId} AND service_id = ${serviceId}
         AND bucket_at >= ${from} AND bucket_at < ${to}
       ORDER BY bucket_at ASC
       LIMIT ${limit}
    `);
    return result.rows.map((row) => ({
      takenAt: new Date(row['taken_at'] as string | Date),
      usedBytes: BigInt(row['used_bytes'] as string | bigint),
      totalBytes:
        row['total_bytes'] === null ? null : BigInt(row['total_bytes'] as string | bigint),
      expiresAt: row['expires_at'] === null ? null : new Date(row['expires_at'] as string | Date),
    }));
  }
}
