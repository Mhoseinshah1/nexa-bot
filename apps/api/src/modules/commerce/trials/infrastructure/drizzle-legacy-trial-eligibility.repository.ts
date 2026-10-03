import { and, eq } from 'drizzle-orm';
import type { LegacyTrialDecision, TenantContext, UserId } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { legacyTrialEligibility } from '../../../../infrastructure/persistence/schema.js';
import type {
  LegacyTrialEligibilityRepository,
  LegacyTrialRecord,
} from '../application/legacy-trial-eligibility.js';

/** Legacy trial decisions, in PostgreSQL. Every query leads with the tenant. */
export class DrizzleLegacyTrialEligibilityRepository implements LegacyTrialEligibilityRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async find(
    scope: TenantContext,
    customerId: UserId,
    tx?: TransactionScope,
  ): Promise<LegacyTrialRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(legacyTrialEligibility)
      .where(
        and(
          eq(legacyTrialEligibility.tenantId, tenantId),
          eq(legacyTrialEligibility.customerId, customerId),
        ),
      )
      .limit(1);
    return rows[0] === undefined ? null : toRecord(rows[0]);
  }

  async insert(
    scope: TenantContext,
    record: Omit<LegacyTrialRecord, 'recordedAt'>,
    now: Date,
    tx: TransactionScope,
  ): Promise<LegacyTrialRecord> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(legacyTrialEligibility)
      .values({ tenantId, ...record, recordedAt: now })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error('legacy_trial_eligibility insert returned no row.');
    return toRecord(row);
  }
}

function toRecord(row: typeof legacyTrialEligibility.$inferSelect): LegacyTrialRecord {
  return {
    customerId: row.customerId as UserId,
    legacyLimitUsertest: row.legacyLimitUsertest,
    legacyHadTrial: row.legacyHadTrial,
    decision: row.decision as LegacyTrialDecision,
    overrideBefore: row.overrideBefore,
    overrideAfter: row.overrideAfter,
    inputHash: row.inputHash,
    recordedAt: row.recordedAt,
  };
}
