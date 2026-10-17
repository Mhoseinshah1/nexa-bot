import { and, eq, inArray, sql } from 'drizzle-orm';
import type { IdGenerator, TenantContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { referrals } from '../../../../infrastructure/persistence/schema.js';
import { MIRZA_SOURCE } from '../application/materialize-support.js';
import {
  referralFingerprint,
  type ReferralHistoryRepository,
  type ReferralWrite,
} from '../application/referral-history.step.js';
import type { MaterializeContext } from '../application/ports.js';

/** `referrals` rows of source MIRZA: an attribution, with no reward and no entry. */
export class DrizzleReferralHistoryRepository implements ReferralHistoryRepository {
  constructor(
    private readonly db: Database,
    private readonly ids: IdGenerator,
  ) {}

  private exec(tx?: TransactionScope): Executor {
    return tx?.tx ?? this.db;
  }

  async insert(
    scope: TenantContext,
    rows: readonly ReferralWrite[],
    _ctx: MaterializeContext,
    tx: TransactionScope,
  ): Promise<ReadonlySet<string>> {
    const tenantId = requireTenantId(scope);
    const inserted = new Set<string>();
    if (rows.length === 0) return inserted;
    const done = await this.exec(tx)
      .insert(referrals)
      .values(
        rows.map((row) => ({
          id: this.ids.uuid(),
          tenantId,
          referrerId: row.referrerId,
          refereeId: row.refereeId,
          trigger: 'ON_SIGNUP',
          // Both NULL: no reward was paid by this import, and none is owed (see the step).
          rewardEntryId: null,
          rewardedAt: null,
          createdAt: row.createdAt,
          source: MIRZA_SOURCE,
          sourceRef: row.sourceRef,
        })),
      )
      .onConflictDoNothing()
      .returning({ sourceRef: referrals.sourceRef });
    for (const r of done) if (r.sourceRef !== null) inserted.add(r.sourceRef);
    return inserted;
  }

  async fingerprints(
    scope: TenantContext,
    wanted: readonly { readonly sourceRef: string }[],
    tx?: TransactionScope,
  ): Promise<ReadonlyMap<string, string>> {
    const out = new Map<string, string>();
    if (wanted.length === 0) return out;
    const sourceRefs = wanted.map((w) => w.sourceRef);
    const rows = await this.exec(tx)
      .select()
      .from(referrals)
      .where(
        and(
          eq(referrals.tenantId, requireTenantId(scope)),
          inArray(referrals.sourceRef, [...sourceRefs]),
        ),
      );
    for (const row of rows) {
      if (row.sourceRef !== null) out.set(row.sourceRef, referralFingerprint(row));
    }
    return out;
  }

  async existingByReferee(
    scope: TenantContext,
    refereeIds: readonly string[],
    tx?: TransactionScope,
  ) {
    const out = new Map<string, string | null>();
    if (refereeIds.length === 0) return out;
    const rows = await this.exec(tx)
      .select({ refereeId: referrals.refereeId, sourceRef: referrals.sourceRef })
      .from(referrals)
      .where(
        and(
          eq(referrals.tenantId, requireTenantId(scope)),
          inArray(referrals.refereeId, [...new Set(refereeIds)]),
        ),
      );
    for (const row of rows) out.set(row.refereeId, row.sourceRef);
    return out;
  }

  async totals(scope: TenantContext) {
    const [row] = await this.db
      .select({ rows: sql<number>`count(*)::int` })
      .from(referrals)
      .where(
        and(eq(referrals.tenantId, requireTenantId(scope)), eq(referrals.source, MIRZA_SOURCE)),
      );
    return { rows: row?.rows ?? 0, sumMinor: null };
  }
}
