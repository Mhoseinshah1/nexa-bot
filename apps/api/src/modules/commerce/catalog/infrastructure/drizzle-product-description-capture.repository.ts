import { and, desc, eq, gte, isNull, or, sql } from 'drizzle-orm';
import type { ProductDescriptionCaptureCloseReason, TenantContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  admins,
  productDescriptionCaptures,
} from '../../../../infrastructure/persistence/schema.js';
import { ScopeBound } from '../../../../infrastructure/persistence/database-scope.js';
import type {
  ProductDescriptionCaptureRecord,
  ProductDescriptionCaptureRepository,
} from '../application/product-description-capture.service.js';

/** The advisory-lock CLASS for an administrator's description capture. */
export const PRODUCT_DESCRIPTION_CAPTURE_LOCK_CLASS = 0x5043;

/**
 * Description capture requests, in PostgreSQL. Every query carries the tenant, and every close
 * and every capture is conditional on the row still being open, so two messages arriving
 * together change it once.
 */
@ScopeBound()
export class DrizzleProductDescriptionCaptureRepository implements ProductDescriptionCaptureRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async lockForAdmin(scope: TenantContext, adminId: string, tx: unknown): Promise<void> {
    const tenantId = requireTenantId(scope);
    await this.exec(tx).execute(
      sql`SELECT pg_advisory_xact_lock(${PRODUCT_DESCRIPTION_CAPTURE_LOCK_CLASS},
            hashtext(${`${tenantId}:${adminId}`}))`,
    );
  }

  async open(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly adminId: string;
      readonly productId: string;
      readonly openedAt: Date;
      readonly expiresAt: Date;
    },
    tx: unknown,
  ): Promise<ProductDescriptionCaptureRecord> {
    const tenantId = requireTenantId(scope);
    // Close first, in this transaction: the partial unique index refuses a second open row.
    await this.exec(tx)
      .update(productDescriptionCaptures)
      .set({ closedAt: input.openedAt, closeReason: 'SUPERSEDED' })
      .where(
        and(
          eq(productDescriptionCaptures.tenantId, tenantId),
          eq(productDescriptionCaptures.adminId, input.adminId),
          isNull(productDescriptionCaptures.closedAt),
        ),
      );
    const rows = await this.exec(tx)
      .insert(productDescriptionCaptures)
      .values({
        id: input.id,
        tenantId,
        adminId: input.adminId,
        productId: input.productId,
        openedAt: input.openedAt,
        expiresAt: input.expiresAt,
      })
      .returning();
    return toRecord(rows[0] as typeof productDescriptionCaptures.$inferSelect);
  }

  async findById(
    scope: TenantContext,
    id: string,
    tx?: unknown,
  ): Promise<ProductDescriptionCaptureRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(productDescriptionCaptures)
      .where(
        and(
          eq(productDescriptionCaptures.tenantId, tenantId),
          eq(productDescriptionCaptures.id, id),
        ),
      )
      .limit(1);
    return rows[0] === undefined ? null : toRecord(rows[0]);
  }

  async findOpenForAdmin(
    scope: TenantContext,
    adminId: string,
    tx?: unknown,
  ): Promise<ProductDescriptionCaptureRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(productDescriptionCaptures)
      .where(
        and(
          eq(productDescriptionCaptures.tenantId, tenantId),
          eq(productDescriptionCaptures.adminId, adminId),
          isNull(productDescriptionCaptures.closedAt),
        ),
      )
      .limit(1);
    return rows[0] === undefined ? null : toRecord(rows[0]);
  }

  async findCurrentByTelegramUser(
    scope: TenantContext,
    telegramUserId: string,
    closedSince: Date,
    tx?: unknown,
  ): Promise<ProductDescriptionCaptureRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ capture: productDescriptionCaptures })
      .from(productDescriptionCaptures)
      .innerJoin(
        admins,
        and(
          eq(admins.tenantId, productDescriptionCaptures.tenantId),
          eq(admins.id, productDescriptionCaptures.adminId),
        ),
      )
      .where(
        and(
          eq(productDescriptionCaptures.tenantId, tenantId),
          eq(admins.telegramUserId, telegramUserId),
          or(
            isNull(productDescriptionCaptures.closedAt),
            gte(productDescriptionCaptures.closedAt, closedSince),
          ),
        ),
      )
      .orderBy(desc(productDescriptionCaptures.openedAt))
      .limit(1);
    return rows[0] === undefined ? null : toRecord(rows[0].capture);
  }

  async close(
    scope: TenantContext,
    id: string,
    reason: Exclude<ProductDescriptionCaptureCloseReason, 'CAPTURED'>,
    at: Date,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(productDescriptionCaptures)
      .set({ closedAt: at, closeReason: reason })
      .where(
        and(
          eq(productDescriptionCaptures.tenantId, tenantId),
          eq(productDescriptionCaptures.id, id),
          isNull(productDescriptionCaptures.closedAt),
        ),
      )
      .returning({ id: productDescriptionCaptures.id });
    return rows.length > 0;
  }

  async capture(
    scope: TenantContext,
    id: string,
    text: string,
    at: Date,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(productDescriptionCaptures)
      .set({ closedAt: at, closeReason: 'CAPTURED', capturedText: text })
      .where(
        and(
          eq(productDescriptionCaptures.tenantId, tenantId),
          eq(productDescriptionCaptures.id, id),
          isNull(productDescriptionCaptures.closedAt),
        ),
      )
      .returning({ id: productDescriptionCaptures.id });
    return rows.length > 0;
  }
}

function toRecord(
  row: typeof productDescriptionCaptures.$inferSelect,
): ProductDescriptionCaptureRecord {
  return {
    id: row.id,
    adminId: row.adminId,
    productId: row.productId,
    openedAt: row.openedAt,
    expiresAt: row.expiresAt,
    closedAt: row.closedAt,
    // Narrowed from `text`: `product_description_captures_close_reason_check` makes it safe.
    closeReason: row.closeReason as ProductDescriptionCaptureCloseReason | null,
    capturedText: row.capturedText,
  };
}
