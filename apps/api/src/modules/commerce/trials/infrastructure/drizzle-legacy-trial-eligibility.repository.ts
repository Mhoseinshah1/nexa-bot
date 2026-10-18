import { and, eq, inArray } from 'drizzle-orm';
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
/** Records per INSERT: 9 parameters a row, far under PostgreSQL's 65 535. */
const INSERT_CHUNK = 5000;
/** Keys per `IN (…)` read. */
const READ_CHUNK = 10_000;

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

  /** `find` for many customers in one read; a customer with no record is not in the map. */
  async findMany(
    scope: TenantContext,
    customerIds: readonly UserId[],
    tx?: TransactionScope,
  ): Promise<ReadonlyMap<string, LegacyTrialRecord>> {
    const tenantId = requireTenantId(scope);
    const out = new Map<string, LegacyTrialRecord>();
    for (let i = 0; i < customerIds.length; i += READ_CHUNK) {
      const rows = await this.exec(tx)
        .select()
        .from(legacyTrialEligibility)
        .where(
          and(
            eq(legacyTrialEligibility.tenantId, tenantId),
            inArray(legacyTrialEligibility.customerId, customerIds.slice(i, i + READ_CHUNK)),
          ),
        );
      for (const row of rows) out.set(row.customerId, toRecord(row));
    }
    return out;
  }

  /** `insert` for many records: multi-row inserts, the answers in the records' order. */
  async insertMany(
    scope: TenantContext,
    records: readonly Omit<LegacyTrialRecord, 'recordedAt'>[],
    now: Date,
    tx: TransactionScope,
  ): Promise<LegacyTrialRecord[]> {
    const tenantId = requireTenantId(scope);
    const byCustomer = new Map<string, LegacyTrialRecord>();
    for (let i = 0; i < records.length; i += INSERT_CHUNK) {
      const chunk = records.slice(i, i + INSERT_CHUNK);
      const rows = await this.exec(tx)
        .insert(legacyTrialEligibility)
        .values(chunk.map((record) => ({ tenantId, ...record, recordedAt: now })))
        .returning();
      if (rows.length !== chunk.length) {
        throw new Error('legacy_trial_eligibility insert returned fewer rows than it was given.');
      }
      for (const row of rows) byCustomer.set(row.customerId, toRecord(row));
    }
    return records.map((record) => {
      const row = byCustomer.get(record.customerId);
      if (row === undefined) throw new Error('legacy_trial_eligibility insert returned no row.');
      return row;
    });
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
