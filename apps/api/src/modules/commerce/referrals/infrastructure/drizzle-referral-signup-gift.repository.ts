import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { DISCOUNTABLE_PURPOSES, money } from '@nexa/contracts';
import type { CurrencyCode, ReferralSignupGiftSide, TenantContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  orders,
  provisioningOperations,
  referralSignupGifts,
  referrals,
  walletEntries,
} from '../../../../infrastructure/persistence/schema.js';
import { PURCHASED_AS } from '../../provisioning/application/provisioner.service.js';
import type {
  OpenReferralSignupGiftSide,
  ReferralRecord,
  ReferralSignupGiftRecord,
  ReferralSignupGiftRepository,
  ReferredPurchaseTotals,
} from '../application/ports.js';

function exec(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

function toGift(row: typeof referralSignupGifts.$inferSelect): ReferralSignupGiftRecord {
  return {
    id: row.id,
    referralId: row.referralId,
    referrerId: row.referrerId,
    refereeId: row.refereeId,
    total: money(row.totalAmount, row.currency as CurrencyCode),
    referrerAmount: row.referrerAmount,
    refereeAmount: row.refereeAmount,
    referrerEntryId: row.referrerEntryId,
    refereeEntryId: row.refereeEntryId,
    referrerClaimedAt: row.referrerClaimedAt,
    refereeClaimedAt: row.refereeClaimedAt,
    createdAt: row.createdAt,
  };
}

function toReferral(row: typeof referrals.$inferSelect): ReferralRecord {
  return {
    id: row.id,
    referrerId: row.referrerId,
    refereeId: row.refereeId,
    trigger: row.trigger as ReferralRecord['trigger'],
    createdAt: row.createdAt,
  };
}

/** The signup gift rows and the referral statistics, in PostgreSQL. Every query carries the tenant. */
export class DrizzleReferralSignupGiftRepository implements ReferralSignupGiftRepository {
  constructor(private readonly db: Database) {}

  async openSides(
    scope: TenantContext,
    customerId: string,
    tx?: unknown,
  ): Promise<readonly OpenReferralSignupGiftSide[]> {
    const tenantId = requireTenantId(scope);
    const rows = await exec(this.db, tx)
      .select({
        referralId: referrals.id,
        referrerId: referrals.referrerId,
        refereeId: referrals.refereeId,
        giftId: referralSignupGifts.id,
        referrerAmount: referralSignupGifts.referrerAmount,
        refereeAmount: referralSignupGifts.refereeAmount,
        currency: referralSignupGifts.currency,
        referrerClaimedAt: referralSignupGifts.referrerClaimedAt,
        refereeClaimedAt: referralSignupGifts.refereeClaimedAt,
      })
      .from(referrals)
      .leftJoin(
        referralSignupGifts,
        and(
          eq(referralSignupGifts.tenantId, referrals.tenantId),
          eq(referralSignupGifts.referralId, referrals.id),
        ),
      )
      .where(
        and(
          eq(referrals.tenantId, tenantId),
          or(eq(referrals.refereeId, customerId), eq(referrals.referrerId, customerId)),
          // The database forbids it; re-stated so a row that somehow carries it is never offered.
          sql`${referrals.referrerId} <> ${referrals.refereeId}`,
        ),
      )
      .orderBy(asc(referrals.id));

    const open: OpenReferralSignupGiftSide[] = [];
    for (const row of rows) {
      const side: ReferralSignupGiftSide = row.refereeId === customerId ? 'REFEREE' : 'REFERRER';
      if (row.giftId === null) {
        open.push({
          referralId: row.referralId,
          side,
          snapshotAmount: null,
          snapshotCurrency: null,
        });
        continue;
      }
      const claimedAt = side === 'REFEREE' ? row.refereeClaimedAt : row.referrerClaimedAt;
      if (claimedAt !== null) continue;
      const snapshotAmount = side === 'REFEREE' ? row.refereeAmount : row.referrerAmount;
      open.push({
        referralId: row.referralId,
        side,
        snapshotAmount,
        snapshotCurrency: row.currency as CurrencyCode,
      });
    }
    return open;
  }

  async lockReferralsOf(
    scope: TenantContext,
    customerId: string,
    tx: unknown,
  ): Promise<readonly ReferralRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await exec(this.db, tx)
      .select()
      .from(referrals)
      .where(
        and(
          eq(referrals.tenantId, tenantId),
          or(eq(referrals.refereeId, customerId), eq(referrals.referrerId, customerId)),
        ),
      )
      .orderBy(asc(referrals.id))
      .for('update');
    return rows.map(toReferral);
  }

  async findByReferral(
    scope: TenantContext,
    referralId: string,
    options: { readonly forUpdate: boolean },
    tx: unknown,
  ): Promise<ReferralSignupGiftRecord | null> {
    const tenantId = requireTenantId(scope);
    const query = exec(this.db, tx)
      .select()
      .from(referralSignupGifts)
      .where(
        and(
          eq(referralSignupGifts.tenantId, tenantId),
          eq(referralSignupGifts.referralId, referralId),
        ),
      )
      .limit(1);
    const [row] = options.forUpdate ? await query.for('update') : await query;
    return row === undefined ? null : toGift(row);
  }

  async insert(
    scope: TenantContext,
    draft: {
      readonly id: string;
      readonly referralId: string;
      readonly referrerId: string;
      readonly refereeId: string;
      readonly total: { readonly amountMinor: bigint; readonly currency: CurrencyCode };
      readonly referrerAmount: bigint;
      readonly refereeAmount: bigint;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await exec(this.db, tx)
      .insert(referralSignupGifts)
      .values({
        id: draft.id,
        tenantId,
        referralId: draft.referralId,
        referrerId: draft.referrerId,
        refereeId: draft.refereeId,
        totalAmount: draft.total.amountMinor,
        referrerAmount: draft.referrerAmount,
        refereeAmount: draft.refereeAmount,
        currency: draft.total.currency,
        createdAt: draft.now,
      })
      .onConflictDoNothing({
        target: [referralSignupGifts.tenantId, referralSignupGifts.referralId],
      })
      .returning({ id: referralSignupGifts.id });
    return rows.length === 1;
  }

  async claimSide(
    scope: TenantContext,
    giftId: string,
    side: ReferralSignupGiftSide,
    stamp: { readonly entryId: string; readonly now: Date },
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const patch =
      side === 'REFEREE'
        ? { refereeEntryId: stamp.entryId, refereeClaimedAt: stamp.now }
        : { referrerEntryId: stamp.entryId, referrerClaimedAt: stamp.now };
    const unclaimed =
      side === 'REFEREE'
        ? isNull(referralSignupGifts.refereeClaimedAt)
        : isNull(referralSignupGifts.referrerClaimedAt);
    const rows = await exec(this.db, tx)
      .update(referralSignupGifts)
      .set(patch)
      .where(
        and(
          eq(referralSignupGifts.tenantId, tenantId),
          eq(referralSignupGifts.id, giftId),
          unclaimed,
        ),
      )
      .returning({ id: referralSignupGifts.id });
    return rows.length === 1;
  }

  /**
   * "Delivered" is the same predicate the commission earner reads, from the same
   * `PURCHASED_AS` table: an operation of the type the order bought having `SUCCEEDED`.
   * A trial is not a purchase (`DISCOUNTABLE_PURPOSES` is the paid list), and only one
   * currency is summed — an implicit conversion at a rate nobody chose is not a total.
   */
  async referredPurchases(
    scope: TenantContext,
    referrerId: string,
    currency: CurrencyCode,
    tx?: unknown,
  ): Promise<ReferredPurchaseTotals> {
    const tenantId = requireTenantId(scope);
    const purchasedAs = sql.join(
      Object.entries(PURCHASED_AS).map(([purpose, type]) => sql`WHEN ${purpose} THEN ${type}`),
      sql` `,
    );
    const delivered = sql`EXISTS (
      SELECT 1 FROM ${provisioningOperations} op
      WHERE op.tenant_id = ${orders.tenantId}
        AND op.order_id = ${orders.id}
        AND op.state = 'SUCCEEDED'
        AND op.type = (CASE ${orders.purpose} ${purchasedAs} END)
    )`;
    const paidPurposes = sql.join(
      DISCOUNTABLE_PURPOSES.map((p) => sql`${p}`),
      sql`, `,
    );
    const [row] = await exec(this.db, tx)
      .select({
        count: sql<number>`count(*)::int`,
        total: sql<string>`COALESCE(SUM(${orders.totalAmount}), 0)::text`,
      })
      .from(orders)
      .innerJoin(
        referrals,
        and(eq(referrals.tenantId, orders.tenantId), eq(referrals.refereeId, orders.customerId)),
      )
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(referrals.referrerId, referrerId),
          eq(orders.state, 'PAID'),
          eq(orders.currency, currency),
          sql`${orders.purpose} IN (${paidPurposes})`,
          delivered,
        ),
      );
    return { count: row?.count ?? 0, total: BigInt(row?.total ?? '0') };
  }

  async netCommission(
    scope: TenantContext,
    customerId: string,
    currency: CurrencyCode,
    tx?: unknown,
  ): Promise<bigint> {
    const tenantId = requireTenantId(scope);
    const [row] = await exec(this.db, tx)
      .select({
        net: sql<string>`COALESCE(SUM(CASE
          WHEN ${walletEntries.reason} = 'REFERRAL_COMMISSION' AND ${walletEntries.direction} = 'CREDIT' THEN ${walletEntries.amount}
          WHEN ${walletEntries.reason} = 'REFERRAL_COMMISSION_REVERSAL' AND ${walletEntries.direction} = 'DEBIT' THEN -${walletEntries.amount}
          ELSE 0 END), 0)::text`,
      })
      .from(walletEntries)
      .where(
        and(
          eq(walletEntries.tenantId, tenantId),
          eq(walletEntries.customerId, customerId),
          eq(walletEntries.currency, currency),
        ),
      );
    return BigInt(row?.net ?? '0');
  }
}
