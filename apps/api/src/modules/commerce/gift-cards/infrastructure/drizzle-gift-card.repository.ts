import { and, count, desc, eq, gte, isNotNull, isNull, lt, lte, sql, type SQL } from 'drizzle-orm';
import {
  money,
  type CurrencyCode,
  type GiftCardBatchState,
  type GiftCardCodeState,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  giftCardBatches,
  giftCardCodes,
  giftCardRedemptionAttempts,
} from '../../../../infrastructure/persistence/schema.js';
import type {
  GiftCardBatchCounts,
  GiftCardBatchCursor,
  GiftCardBatchListing,
  GiftCardBatchRecord,
  GiftCardCodeRecord,
  GiftCardRepository,
  GiftCardSweepRepository,
  NewGiftCardBatch,
  NewGiftCardCode,
} from '../application/ports.js';

/** Rows per INSERT: 1000 codes × 5 columns stays far below PostgreSQL's parameter ceiling. */
const INSERT_CHUNK = 1000;

function exec(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

function toBatch(row: typeof giftCardBatches.$inferSelect): GiftCardBatchRecord {
  return {
    id: row.id,
    label: row.label,
    amount: money(row.amountMinor, row.currency as CurrencyCode),
    codeCount: row.codeCount,
    perCustomerLimit: row.perCustomerLimit,
    expiresAt: row.expiresAt,
    state: row.state as GiftCardBatchState,
    reason: row.reason,
    createdByAdminId: row.createdByAdminId,
    createdAt: row.createdAt,
    disabledAt: row.disabledAt,
    disabledByAdminId: row.disabledByAdminId,
    exportExpiresAt: row.exportExpiresAt,
    sealedExport:
      row.exportCiphertext === null || row.exportKeyId === null
        ? null
        : { ciphertext: row.exportCiphertext, keyId: row.exportKeyId },
  };
}

function toCode(row: typeof giftCardCodes.$inferSelect): GiftCardCodeRecord {
  return {
    id: row.id,
    batchId: row.batchId,
    last4: row.last4,
    state: row.state as GiftCardCodeState,
    redeemedAt: row.redeemedAt,
    redeemedByCustomerId: row.redeemedByCustomerId,
    walletEntryId: row.walletEntryId,
  };
}

/** The three counts of a batch, in one pass over its code rows. */
const COUNT_COLUMNS = {
  redeemed: sql<number>`count(*) FILTER (WHERE ${giftCardCodes.redeemedAt} IS NOT NULL)::int`,
  disabled: sql<number>`count(*) FILTER (WHERE ${giftCardCodes.state} = 'DISABLED')::int`,
  unredeemed: sql<number>`count(*) FILTER (WHERE ${giftCardCodes.redeemedAt} IS NULL
    AND ${giftCardCodes.state} = 'ACTIVE')::int`,
};

/** Gift card batches, codes and refused attempts, in PostgreSQL. Every query carries the tenant. */
export class DrizzleGiftCardRepository implements GiftCardRepository, GiftCardSweepRepository {
  constructor(private readonly db: Database) {}

  async insertBatch(
    scope: TenantContext,
    batch: NewGiftCardBatch,
    codes: readonly NewGiftCardCode[],
    tx: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    const db = exec(this.db, tx);
    await db.insert(giftCardBatches).values({
      id: batch.id,
      tenantId,
      label: batch.label,
      amountMinor: batch.amount.amountMinor,
      currency: batch.amount.currency,
      codeCount: batch.codeCount,
      perCustomerLimit: batch.perCustomerLimit,
      expiresAt: batch.expiresAt,
      state: 'ACTIVE',
      reason: batch.reason,
      createdByAdminId: batch.createdByAdminId,
      createdAt: batch.createdAt,
      exportCiphertext: batch.sealedExport.ciphertext,
      exportKeyId: batch.sealedExport.keyId,
      exportExpiresAt: batch.exportExpiresAt,
    });
    for (let at = 0; at < codes.length; at += INSERT_CHUNK) {
      await db.insert(giftCardCodes).values(
        codes.slice(at, at + INSERT_CHUNK).map((code) => ({
          id: code.id,
          tenantId,
          batchId: batch.id,
          codeHash: code.codeHash,
          last4: code.last4,
          state: 'ACTIVE',
        })),
      );
    }
  }

  async findBatch(
    scope: TenantContext,
    batchId: string,
    options: { readonly lock?: 'share' | 'update' },
    tx?: unknown,
  ): Promise<GiftCardBatchRecord | null> {
    const tenantId = requireTenantId(scope);
    const query = exec(this.db, tx)
      .select()
      .from(giftCardBatches)
      .where(and(eq(giftCardBatches.tenantId, tenantId), eq(giftCardBatches.id, batchId)))
      .limit(1);
    const [row] = options.lock === undefined ? await query : await query.for(options.lock);
    return row === undefined ? null : toBatch(row);
  }

  async listBatches(
    scope: TenantContext,
    query: { readonly limit: number; readonly cursor?: GiftCardBatchCursor },
  ): Promise<{
    readonly items: readonly GiftCardBatchListing[];
    readonly next: GiftCardBatchCursor | null;
  }> {
    const tenantId = requireTenantId(scope);
    const conditions: (SQL | undefined)[] = [eq(giftCardBatches.tenantId, tenantId)];
    if (query.cursor !== undefined) {
      conditions.push(
        sql`(${giftCardBatches.createdAt}, ${giftCardBatches.id}) < (${query.cursor.createdAt}::timestamptz, ${query.cursor.id}::uuid)`,
      );
    }
    const rows = await this.db
      .select()
      .from(giftCardBatches)
      .where(and(...conditions))
      .orderBy(desc(giftCardBatches.createdAt), desc(giftCardBatches.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const items: GiftCardBatchListing[] = [];
    for (const row of page) {
      items.push({ batch: toBatch(row), counts: await this.counts(scope, row.id) });
    }
    const last = page[page.length - 1];
    return {
      items,
      next:
        rows.length > query.limit && last !== undefined
          ? { createdAt: last.createdAt.toISOString(), id: last.id }
          : null,
    };
  }

  async counts(scope: TenantContext, batchId: string, tx?: unknown): Promise<GiftCardBatchCounts> {
    const tenantId = requireTenantId(scope);
    const [row] = await exec(this.db, tx)
      .select(COUNT_COLUMNS)
      .from(giftCardCodes)
      .where(and(eq(giftCardCodes.tenantId, tenantId), eq(giftCardCodes.batchId, batchId)));
    return {
      redeemed: Number(row?.redeemed ?? 0),
      disabled: Number(row?.disabled ?? 0),
      unredeemed: Number(row?.unredeemed ?? 0),
    };
  }

  async findCodeByHash(
    scope: TenantContext,
    codeHash: string,
    tx: unknown,
  ): Promise<GiftCardCodeRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await exec(this.db, tx)
      .select()
      .from(giftCardCodes)
      .where(and(eq(giftCardCodes.tenantId, tenantId), eq(giftCardCodes.codeHash, codeHash)))
      .limit(1);
    return row === undefined ? null : toCode(row);
  }

  async redeemCode(
    scope: TenantContext,
    input: {
      readonly codeId: string;
      readonly customerId: UserId;
      readonly entryId: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const updated = await exec(this.db, tx)
      .update(giftCardCodes)
      .set({
        redeemedAt: input.now,
        redeemedByCustomerId: input.customerId,
        walletEntryId: input.entryId,
      })
      .where(
        and(
          eq(giftCardCodes.tenantId, tenantId),
          eq(giftCardCodes.id, input.codeId),
          // The `from` states: not yet redeemed, still ACTIVE. The row decides, not a read.
          isNull(giftCardCodes.redeemedAt),
          eq(giftCardCodes.state, 'ACTIVE'),
        ),
      )
      .returning({ id: giftCardCodes.id });
    return updated.length === 1;
  }

  async countRedeemedBy(
    scope: TenantContext,
    batchId: string,
    customerId: UserId,
    tx: unknown,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    const [row] = await exec(this.db, tx)
      .select({ n: count() })
      .from(giftCardCodes)
      .where(
        and(
          eq(giftCardCodes.tenantId, tenantId),
          eq(giftCardCodes.batchId, batchId),
          eq(giftCardCodes.redeemedByCustomerId, customerId),
        ),
      );
    return Number(row?.n ?? 0);
  }

  async disableBatch(
    scope: TenantContext,
    batchId: string,
    input: { readonly adminId: string | null; readonly now: Date },
    tx: unknown,
  ): Promise<{ readonly changed: boolean; readonly codesDisabled: number }> {
    const tenantId = requireTenantId(scope);
    const db = exec(this.db, tx);
    const batch = await db
      .update(giftCardBatches)
      .set({ state: 'DISABLED', disabledAt: input.now, disabledByAdminId: input.adminId })
      .where(
        and(
          eq(giftCardBatches.tenantId, tenantId),
          eq(giftCardBatches.id, batchId),
          eq(giftCardBatches.state, 'ACTIVE'),
        ),
      )
      .returning({ id: giftCardBatches.id });
    if (batch.length === 0) return { changed: false, codesDisabled: 0 };
    // Only the codes nobody redeemed: a redeemed code's money already moved.
    const codes = await db
      .update(giftCardCodes)
      .set({ state: 'DISABLED', disabledAt: input.now })
      .where(
        and(
          eq(giftCardCodes.tenantId, tenantId),
          eq(giftCardCodes.batchId, batchId),
          eq(giftCardCodes.state, 'ACTIVE'),
          isNull(giftCardCodes.redeemedAt),
        ),
      )
      .returning({ id: giftCardCodes.id });
    return { changed: true, codesDisabled: codes.length };
  }

  async recordAttempt(
    scope: TenantContext,
    attempt: {
      readonly id: string;
      readonly customerId: UserId;
      readonly at: Date;
      readonly outcome: string;
      readonly codeId: string | null;
    },
    tx: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    await exec(this.db, tx).insert(giftCardRedemptionAttempts).values({
      id: attempt.id,
      tenantId,
      customerId: attempt.customerId,
      attemptedAt: attempt.at,
      outcome: attempt.outcome,
      codeId: attempt.codeId,
    });
  }

  async countFailedSince(
    scope: TenantContext,
    customerId: UserId,
    since: Date,
    tx: unknown,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    const [row] = await exec(this.db, tx)
      .select({ n: count() })
      .from(giftCardRedemptionAttempts)
      .where(
        and(
          eq(giftCardRedemptionAttempts.tenantId, tenantId),
          eq(giftCardRedemptionAttempts.customerId, customerId),
          gte(giftCardRedemptionAttempts.attemptedAt, since),
        ),
      );
    return Number(row?.n ?? 0);
  }

  async purgeExpiredExports(scope: TenantContext, now: Date, tx: unknown): Promise<number> {
    const tenantId = requireTenantId(scope);
    const purged = await exec(this.db, tx)
      .update(giftCardBatches)
      .set({ exportCiphertext: null, exportKeyId: null })
      .where(
        and(
          eq(giftCardBatches.tenantId, tenantId),
          isNotNull(giftCardBatches.exportCiphertext),
          lte(giftCardBatches.exportExpiresAt, now),
        ),
      )
      .returning({ id: giftCardBatches.id });
    return purged.length;
  }

  async deleteAttemptsBefore(scope: TenantContext, cutoff: Date, tx: unknown): Promise<number> {
    const tenantId = requireTenantId(scope);
    const deleted = await exec(this.db, tx)
      .delete(giftCardRedemptionAttempts)
      .where(
        and(
          eq(giftCardRedemptionAttempts.tenantId, tenantId),
          lt(giftCardRedemptionAttempts.attemptedAt, cutoff),
        ),
      )
      .returning({ id: giftCardRedemptionAttempts.id });
    return deleted.length;
  }
}
