import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  money,
  type CurrencyCode,
  type LegacyShapeResolution,
  type LegacyShapeTariffStatus,
  type LegacyShapeUnresolvedReason,
  type Money,
  type ProductAudience,
  type ProductCategoryStatus,
  type ProductId,
  type ProductStatus,
  type TenantContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  legacyProductShapes,
  productCategories,
  products,
} from '../../../../infrastructure/persistence/schema.js';
import type {
  LegacyProductShapeRepository,
  LegacyShapeRecord,
  LegacyShapeTariffState,
} from '../application/legacy-product-ports.js';
import type { LegacyShape, TariffCandidate } from '../application/legacy-shape.js';

/** Hidden legacy product shapes, in PostgreSQL. Every query leads with the tenant. */
export class DrizzleLegacyProductShapeRepository implements LegacyProductShapeRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async lockKey(scope: TenantContext, shapeKey: string, tx: TransactionScope): Promise<void> {
    const tenantId = requireTenantId(scope);
    await this.exec(tx).execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`legacy-shape:${tenantId}:${shapeKey}`}, 0))`,
    );
  }

  async findByKey(
    scope: TenantContext,
    shapeKey: string,
    tx?: TransactionScope,
  ): Promise<LegacyShapeRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(legacyProductShapes)
      .where(
        and(eq(legacyProductShapes.tenantId, tenantId), eq(legacyProductShapes.shapeKey, shapeKey)),
      )
      .limit(1);
    return rows[0] === undefined ? null : toRecord(rows[0]);
  }

  async findById(
    scope: TenantContext,
    id: string,
    tx?: TransactionScope,
  ): Promise<LegacyShapeRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(legacyProductShapes)
      .where(and(eq(legacyProductShapes.tenantId, tenantId), eq(legacyProductShapes.id, id)))
      .limit(1);
    return rows[0] === undefined ? null : toRecord(rows[0]);
  }

  async lockById(
    scope: TenantContext,
    id: string,
    tx: TransactionScope,
  ): Promise<LegacyShapeRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(legacyProductShapes)
      .where(and(eq(legacyProductShapes.tenantId, tenantId), eq(legacyProductShapes.id, id)))
      .for('update')
      .limit(1);
    return rows[0] === undefined ? null : toRecord(rows[0]);
  }

  async insert(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly shapeKey: string;
      readonly shape: LegacyShape;
      readonly productId: ProductId;
      readonly now: Date;
    },
    tx: TransactionScope,
  ): Promise<LegacyShapeRecord> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(legacyProductShapes)
      .values({
        id: input.id,
        tenantId,
        shapeKey: input.shapeKey,
        legacyCodePanel: input.shape.legacyCodePanel,
        trafficBytes: input.shape.trafficBytes,
        durationDays: input.shape.durationDays,
        isCustom: input.shape.isCustom,
        productId: input.productId,
        tariffStatus: 'UNRESOLVED',
        unresolvedReason: 'NOT_YET_RESOLVED',
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error('legacy_product_shapes insert returned no row.');
    return toRecord(row);
  }

  async setTariffState(
    scope: TenantContext,
    id: string,
    state: LegacyShapeTariffState,
    now: Date,
    tx: TransactionScope,
  ): Promise<LegacyShapeRecord> {
    const tenantId = requireTenantId(scope);
    const columns =
      state.status === 'UNRESOLVED'
        ? {
            tariffStatus: 'UNRESOLVED',
            unresolvedReason: state.reason,
            resolution: null,
            tariffSourceProductId: null,
            resolvedAt: null,
          }
        : {
            tariffStatus: 'RESOLVED',
            unresolvedReason: null,
            resolution: state.resolution,
            tariffSourceProductId: state.sourceProductId,
            resolvedAt: state.resolvedAt,
          };
    const rows = await this.exec(tx)
      .update(legacyProductShapes)
      .set({ ...columns, updatedAt: now })
      .where(and(eq(legacyProductShapes.tenantId, tenantId), eq(legacyProductShapes.id, id)))
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error('legacy_product_shapes update matched no row.');
    return toRecord(row);
  }

  async tariffCandidates(
    scope: TenantContext,
    shape: Pick<LegacyShape, 'trafficBytes' | 'durationDays'>,
    tx: TransactionScope,
  ): Promise<readonly TariffCandidate[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({
        id: products.id,
        status: products.status,
        audience: products.audience,
        durationDays: products.durationDays,
        trafficBytes: products.trafficBytes,
        priceAmount: products.priceAmount,
        priceCurrency: products.priceCurrency,
        panelId: products.panelId,
        categoryStatus: productCategories.status,
      })
      .from(products)
      .leftJoin(
        productCategories,
        and(
          eq(productCategories.id, products.categoryId),
          eq(productCategories.tenantId, products.tenantId),
        ),
      )
      .where(
        and(
          eq(products.tenantId, tenantId),
          eq(products.trafficBytes, shape.trafficBytes),
          eq(products.durationDays, shape.durationDays),
        ),
      )
      .orderBy(products.id);
    return rows.map((row) => ({
      id: row.id,
      status: row.status as ProductStatus,
      audience: row.audience as ProductAudience,
      durationDays: row.durationDays,
      trafficBytes: row.trafficBytes,
      price:
        row.priceAmount === null || row.priceCurrency === null
          ? null
          : money(row.priceAmount, row.priceCurrency as CurrencyCode),
      panelBound: row.panelId !== null,
      categoryStatus: row.categoryStatus as ProductCategoryStatus | null,
    }));
  }

  async priceHiddenProduct(
    scope: TenantContext,
    productId: ProductId,
    price: Money,
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(products)
      .set({
        priceAmount: price.amountMinor,
        priceCurrency: price.currency,
        status: 'ACTIVE',
        updatedAt: now,
      })
      .where(
        and(
          eq(products.tenantId, tenantId),
          eq(products.id, productId),
          eq(products.audience, 'HIDDEN'),
          isNull(products.categoryId),
        ),
      )
      .returning({ id: products.id });
    return rows.length > 0;
  }
}

function toRecord(row: typeof legacyProductShapes.$inferSelect): LegacyShapeRecord {
  return {
    id: row.id,
    shapeKey: row.shapeKey,
    legacyCodePanel: row.legacyCodePanel,
    trafficBytes: row.trafficBytes,
    durationDays: row.durationDays,
    isCustom: row.isCustom,
    productId: row.productId as ProductId,
    tariffStatus: row.tariffStatus as LegacyShapeTariffStatus,
    unresolvedReason: row.unresolvedReason as LegacyShapeUnresolvedReason | null,
    resolution: row.resolution as LegacyShapeResolution | null,
    tariffSourceProductId: row.tariffSourceProductId as ProductId | null,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
