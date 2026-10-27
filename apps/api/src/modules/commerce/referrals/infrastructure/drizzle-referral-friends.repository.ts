import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { TenantContext } from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { requireTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';
import { customers, referrals } from '../../../../infrastructure/persistence/schema.js';
import type {
  ReferralCursor,
  ReferralFriendCounts,
  ReferralFriendRow,
  ReferralFriendStatus,
  ReferralFriendsRepository,
} from '../application/ports.js';
import { refereeQualified } from './drizzle-referral-signup-gift.repository.js';

/**
 * A pending commission of THIS referral, by the referral's own table name (the same reason
 * `refereeQualified` names it: inside a subquery a bare `tenant_id` would bind to the
 * commission's, not the referral's).
 */
const COMMISSION_OF_REFERRAL = sql.raw(`
  rc.tenant_id = referrals.tenant_id AND rc.referral_id = referrals.id`);

/**
 * The status of the referral at hand, in ONE expression: the page selects it and the counts
 * group by it, so the two can never disagree about a friend.
 *
 *  - REWARD_PAID: a commission of this referral was EARNED for more than nothing (an earned
 *    zero credited nobody, so it is not a reward paid);
 *  - REWARD_PENDING: a commission is still PENDING (promised, waiting for delivery, or held
 *    back by the referrer's daily cap);
 *  - PURCHASED: the referee has a delivered, paid, sale-origin order (`refereeQualified`,
 *    the gift claim's own definition of "delivered");
 *  - JOINED: none of those.
 *
 * Read-only. Nothing here locks, writes or moves money.
 */
function statusSql(): SQL<ReferralFriendStatus> {
  return sql<ReferralFriendStatus>`CASE
    WHEN EXISTS (
      SELECT 1 FROM order_referral_commissions rc
       WHERE ${COMMISSION_OF_REFERRAL} AND rc.state = 'EARNED' AND rc.earned_amount > 0
    ) THEN 'REWARD_PAID'
    WHEN EXISTS (
      SELECT 1 FROM order_referral_commissions rc
       WHERE ${COMMISSION_OF_REFERRAL} AND rc.state = 'PENDING'
    ) THEN 'REWARD_PENDING'
    WHEN ${refereeQualified()} THEN 'PURCHASED'
    ELSE 'JOINED'
  END`;
}

/**
 * The earliest `not_before` of this referral's pending commissions — but only when EVERY
 * pending one carries one. A pending commission with none is waiting for delivery, not for a
 * day, so "held until" would be a promise nobody made.
 */
function pendingNotBeforeSql(): SQL<Date | null> {
  return sql<Date | null>`(
    SELECT CASE WHEN count(*) = count(rc.not_before) THEN min(rc.not_before) END
      FROM order_referral_commissions rc
     WHERE ${COMMISSION_OF_REFERRAL} AND rc.state = 'PENDING'
  )`;
}

const CREATED_AT_TEXT = sql<string>`to_char(${referrals.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * The customer's own invited friends, in PostgreSQL (R11 B3). Every query carries the tenant
 * AND the referrer, so another customer's list cannot be read by any id.
 */
export class DrizzleReferralFriendsRepository implements ReferralFriendsRepository {
  constructor(private readonly db: Database) {}

  async page(
    scope: TenantContext,
    referrerId: string,
    limit: number,
    cursor: ReferralCursor | null,
  ): Promise<{
    readonly items: readonly ReferralFriendRow[];
    readonly next: ReferralCursor | null;
  }> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select({
        id: referrals.id,
        createdAt: referrals.createdAt,
        createdAtText: CREATED_AT_TEXT,
        // The two columns a friend is drawn from, and no others of the customer row.
        firstName: customers.firstName,
        username: customers.username,
        status: statusSql(),
        pendingNotBefore: pendingNotBeforeSql(),
      })
      .from(referrals)
      .innerJoin(
        customers,
        and(eq(customers.tenantId, referrals.tenantId), eq(customers.id, referrals.refereeId)),
      )
      .where(
        and(
          eq(referrals.tenantId, tenantId),
          eq(referrals.referrerId, referrerId),
          cursor === null
            ? undefined
            : sql`(${referrals.createdAt}, ${referrals.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
        ),
      )
      .orderBy(desc(referrals.createdAt), desc(referrals.id))
      .limit(limit + 1);
    const shown = rows.slice(0, limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map((row) => ({
        referralId: row.id,
        createdAt: row.createdAt,
        firstName: row.firstName,
        username: row.username,
        status: row.status,
        pendingNotBefore: row.pendingNotBefore === null ? null : new Date(row.pendingNotBefore),
      })),
      next:
        rows.length > limit && last !== undefined
          ? { createdAt: last.createdAtText, id: last.id }
          : null,
    };
  }

  async counts(scope: TenantContext, referrerId: string): Promise<ReferralFriendCounts> {
    const tenantId = requireTenantId(scope);
    const result = await this.db.execute(sql`
      SELECT status, count(*)::int AS n FROM (
        SELECT ${statusSql()} AS status
          FROM referrals
         WHERE referrals.tenant_id = ${tenantId} AND referrals.referrer_id = ${referrerId}
      ) friends
      GROUP BY status`);
    const byStatus = new Map<string, number>(
      (result.rows as { status: string; n: number }[]).map((row) => [row.status, row.n]),
    );
    return {
      joined: byStatus.get('JOINED') ?? 0,
      purchased: byStatus.get('PURCHASED') ?? 0,
      rewardPending: byStatus.get('REWARD_PENDING') ?? 0,
      rewardPaid: byStatus.get('REWARD_PAID') ?? 0,
    };
  }
}
