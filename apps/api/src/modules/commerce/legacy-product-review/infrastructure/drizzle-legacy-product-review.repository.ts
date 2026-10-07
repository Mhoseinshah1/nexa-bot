import { and, asc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import type {
  LegacyProductParseNote,
  LegacyProductParsedField,
  LegacyProductReviewState,
  LegacyProductSourceConflict,
  TenantContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { legacyProductReviews, products } from '../../../../infrastructure/persistence/schema.js';
import type {
  LegacyProductReviewChange,
  LegacyProductReviewGuard,
  LegacyProductReviewListFilter,
  LegacyProductReviewListItem,
  LegacyProductReviewRecord,
  LegacyProductReviewRepository,
} from '../application/ports.js';

type Row = typeof legacyProductReviews.$inferSelect;

function toRecord(row: Row): LegacyProductReviewRecord {
  return {
    id: row.id,
    codeProduct: row.codeProduct,
    legacyProductId: row.legacyProductId,
    facts: row.legacyFacts as LegacyProductReviewRecord['facts'],
    factsChecksum: row.factsChecksum,
    sourceConflict: row.sourceConflict as LegacyProductSourceConflict | null,
    title: row.title,
    trafficBytes: row.trafficBytes,
    durationDays: row.durationDays,
    historicalPriceRaw: row.historicalPriceRaw,
    historicalPriceMinor: row.historicalPriceMinor,
    historicalPriceCurrency: row.historicalPriceCurrency as 'IRT' | null,
    parseNotes: row.parseNotes as Partial<Record<LegacyProductParsedField, LegacyProductParseNote>>,
    liveInvoiceCount: row.liveInvoiceCount,
    state: row.state as LegacyProductReviewState,
    priorState: row.priorState as LegacyProductReviewState | null,
    approvedProductId: row.approvedProductId,
    approvedFactsChecksum: row.approvedFactsChecksum,
    decisionReason: row.decisionReason,
    decidedByAdminId: row.decidedByAdminId,
    decidedAt: row.decidedAt,
    readFingerprint: row.readFingerprint,
    sourceFingerprint: row.sourceFingerprint,
    missingSinceReadFingerprint: row.missingSinceReadFingerprint,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The record's fields as columns. `facts` and `parseNotes` are the two jsonb ones. */
function columnsOf(
  change: LegacyProductReviewChange,
): Partial<typeof legacyProductReviews.$inferInsert> {
  const out: Partial<typeof legacyProductReviews.$inferInsert> = {};
  for (const [key, value] of Object.entries(change)) {
    if (value === undefined) continue;
    if (key === 'facts') out.legacyFacts = value as unknown;
    else (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/** `%`, `_` and `\` typed into a search are literal characters, not patterns. */
function likeLiteral(text: string): string {
  return `%${text.replace(/[\\%_]/gu, (c) => `\\${c}`)}%`;
}

export class DrizzleLegacyProductReviewRepository implements LegacyProductReviewRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: TransactionScope): Executor {
    return tx?.tx ?? this.db;
  }

  async findByCode(
    scope: TenantContext,
    code: string,
    tx: TransactionScope,
    options: { readonly forUpdate?: boolean } = {},
  ): Promise<LegacyProductReviewRecord | null> {
    const tenantId = requireTenantId(scope);
    const query = this.exec(tx)
      .select()
      .from(legacyProductReviews)
      .where(
        and(
          eq(legacyProductReviews.tenantId, tenantId),
          eq(legacyProductReviews.codeProduct, code),
        ),
      )
      .limit(1);
    const rows = options.forUpdate === true ? await query.for('update') : await query;
    return rows[0] === undefined ? null : toRecord(rows[0]);
  }

  async findById(
    scope: TenantContext,
    id: string,
    tx?: TransactionScope,
    options: { readonly forUpdate?: boolean } = {},
  ): Promise<LegacyProductReviewRecord | null> {
    const tenantId = requireTenantId(scope);
    const query = this.exec(tx)
      .select()
      .from(legacyProductReviews)
      .where(and(eq(legacyProductReviews.tenantId, tenantId), eq(legacyProductReviews.id, id)))
      .limit(1);
    const rows = options.forUpdate === true ? await query.for('update') : await query;
    return rows[0] === undefined ? null : toRecord(rows[0]);
  }

  async insert(
    scope: TenantContext,
    row: Omit<LegacyProductReviewRecord, 'version'>,
    tx: TransactionScope,
  ): Promise<LegacyProductReviewRecord | null> {
    const tenantId = requireTenantId(scope);
    const { facts, ...rest } = row;
    const inserted = await this.exec(tx)
      .insert(legacyProductReviews)
      .values({ ...rest, legacyFacts: facts, tenantId, version: 1 })
      .onConflictDoNothing({
        target: [legacyProductReviews.tenantId, legacyProductReviews.codeProduct],
      })
      .returning();
    return inserted[0] === undefined ? null : toRecord(inserted[0]);
  }

  async update(
    scope: TenantContext,
    id: string,
    guard: LegacyProductReviewGuard,
    change: LegacyProductReviewChange,
    tx: TransactionScope,
  ): Promise<LegacyProductReviewRecord | null> {
    if (guard.from.length === 0) throw new Error('a transition names its from-states');
    const tenantId = requireTenantId(scope);
    const updated = await this.exec(tx)
      .update(legacyProductReviews)
      .set({ ...columnsOf(change), version: sql`${legacyProductReviews.version} + 1` })
      .where(
        and(
          eq(legacyProductReviews.tenantId, tenantId),
          eq(legacyProductReviews.id, id),
          inArray(legacyProductReviews.state, [...guard.from]),
          eq(legacyProductReviews.version, guard.version),
          ...(guard.factsChecksum === undefined
            ? []
            : [eq(legacyProductReviews.factsChecksum, guard.factsChecksum)]),
        ),
      )
      .returning();
    return updated[0] === undefined ? null : toRecord(updated[0]);
  }

  async absentFrom(
    scope: TenantContext,
    readFingerprint: string,
    limit: number,
    tx?: TransactionScope,
  ): Promise<readonly LegacyProductReviewRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(legacyProductReviews)
      .where(
        and(
          eq(legacyProductReviews.tenantId, tenantId),
          ne(legacyProductReviews.readFingerprint, readFingerprint),
          isNull(legacyProductReviews.missingSinceReadFingerprint),
        ),
      )
      .orderBy(asc(legacyProductReviews.codeProduct))
      .limit(limit);
    return rows.map(toRecord);
  }

  async findItem(scope: TenantContext, id: string): Promise<LegacyProductReviewListItem | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.withTitle()
      .where(and(eq(legacyProductReviews.tenantId, tenantId), eq(legacyProductReviews.id, id)))
      .limit(1);
    const row = rows[0];
    return row === undefined
      ? null
      : { review: toRecord(row.review), approvedProductTitle: row.productTitle ?? null };
  }

  private withTitle() {
    return this.db
      .select({ review: legacyProductReviews, productTitle: products.title })
      .from(legacyProductReviews)
      .leftJoin(
        products,
        and(
          eq(products.tenantId, legacyProductReviews.tenantId),
          eq(products.id, legacyProductReviews.approvedProductId),
        ),
      );
  }

  async list(
    scope: TenantContext,
    filter: LegacyProductReviewListFilter,
  ): Promise<readonly LegacyProductReviewListItem[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.withTitle()
      .where(
        and(
          eq(legacyProductReviews.tenantId, tenantId),
          ...(filter.states === undefined
            ? []
            : [inArray(legacyProductReviews.state, [...filter.states])]),
          ...(filter.after === undefined
            ? []
            : [gt(legacyProductReviews.codeProduct, filter.after)]),
          ...(filter.q === undefined
            ? []
            : [
                sql`(${legacyProductReviews.codeProduct} ILIKE ${likeLiteral(filter.q)} OR ${legacyProductReviews.title} ILIKE ${likeLiteral(filter.q)})`,
              ]),
        ),
      )
      .orderBy(asc(legacyProductReviews.codeProduct))
      .limit(filter.limit);
    return rows.map((row) => ({
      review: toRecord(row.review),
      approvedProductTitle: row.productTitle ?? null,
    }));
  }

  async all(scope: TenantContext): Promise<readonly LegacyProductReviewRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select()
      .from(legacyProductReviews)
      .where(eq(legacyProductReviews.tenantId, tenantId))
      .orderBy(asc(legacyProductReviews.codeProduct));
    return rows.map(toRecord);
  }

  async productExists(
    scope: TenantContext,
    productId: string,
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.id, productId)))
      .limit(1)
      .for('share');
    return rows.length > 0;
  }
}
