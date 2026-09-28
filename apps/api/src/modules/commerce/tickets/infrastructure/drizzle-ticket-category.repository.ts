import { and, asc, count, eq, sql } from 'drizzle-orm';
import type { TenantContext, TicketCategoryId } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  ticketCategories,
  ticketCategorySeeds,
} from '../../../../infrastructure/persistence/schema.js';
import type { TicketCategoryRecord, TicketCategoryRepository } from '../application/ports.js';

/** One tenant's category writes, serialised (`lockTenant`). 'TC'. */
export const TICKET_CATEGORY_LOCK_CLASS = 0x5443;

type Row = typeof ticketCategories.$inferSelect;

function toRecord(row: Row): TicketCategoryRecord {
  return {
    id: row.id as TicketCategoryId,
    title: row.title,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The tenant's ticket categories and their seed marker. Every query carries the tenant. */
export class DrizzleTicketCategoryRepository implements TicketCategoryRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async list(
    scope: TenantContext,
    options: { readonly activeOnly: boolean },
    tx?: unknown,
  ): Promise<readonly TicketCategoryRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(ticketCategories)
      .where(
        and(
          eq(ticketCategories.tenantId, tenantId),
          options.activeOnly ? eq(ticketCategories.isActive, true) : undefined,
        ),
      )
      .orderBy(asc(ticketCategories.sortOrder), asc(ticketCategories.id));
    return rows.map(toRecord);
  }

  async findById(
    scope: TenantContext,
    id: string,
    tx?: unknown,
  ): Promise<TicketCategoryRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(ticketCategories)
      .where(and(eq(ticketCategories.tenantId, tenantId), eq(ticketCategories.id, id)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async findByTitle(
    scope: TenantContext,
    title: string,
    tx?: unknown,
  ): Promise<TicketCategoryRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(ticketCategories)
      .where(and(eq(ticketCategories.tenantId, tenantId), eq(ticketCategories.title, title)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async count(scope: TenantContext, tx?: unknown): Promise<number> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ total: count() })
      .from(ticketCategories)
      .where(eq(ticketCategories.tenantId, tenantId));
    return Number(rows[0]?.total ?? 0);
  }

  async lockTenant(scope: TenantContext, tx: unknown): Promise<void> {
    const tenantId = requireTenantId(scope);
    await this.exec(tx).execute(
      sql`SELECT pg_advisory_xact_lock(${TICKET_CATEGORY_LOCK_CLASS}, hashtext(${tenantId}))`,
    );
  }

  async insert(
    scope: TenantContext,
    input: {
      readonly id: TicketCategoryId;
      readonly title: string;
      readonly sortOrder: number;
      readonly isActive: boolean;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<TicketCategoryRecord> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(ticketCategories)
      .values({
        id: input.id,
        tenantId,
        title: input.title,
        sortOrder: input.sortOrder,
        isActive: input.isActive,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning();
    const row = rows[0];
    /* istanbul ignore next -- an INSERT ... RETURNING that inserted returns its row. */
    if (row === undefined) throw new Error('A ticket category insert returned no row.');
    return toRecord(row);
  }

  async update(
    scope: TenantContext,
    id: TicketCategoryId,
    patch: { readonly title: string; readonly sortOrder: number; readonly isActive: boolean },
    at: Date,
    tx: unknown,
  ): Promise<TicketCategoryRecord> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(ticketCategories)
      .set({ ...patch, updatedAt: at })
      .where(and(eq(ticketCategories.tenantId, tenantId), eq(ticketCategories.id, id)))
      .returning();
    const row = rows[0];
    /* istanbul ignore next -- the caller read the row under the tenant's category lock. */
    if (row === undefined) throw new Error('A ticket category vanished under its lock.');
    return toRecord(row);
  }

  async hasSeed(scope: TenantContext, tx?: unknown): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ tenantId: ticketCategorySeeds.tenantId })
      .from(ticketCategorySeeds)
      .where(eq(ticketCategorySeeds.tenantId, tenantId))
      .limit(1);
    return rows.length > 0;
  }

  async markSeeded(scope: TenantContext, now: Date, tx: unknown): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const inserted = await this.exec(tx)
      .insert(ticketCategorySeeds)
      .values({ tenantId, seededAt: now })
      .onConflictDoNothing()
      .returning({ tenantId: ticketCategorySeeds.tenantId });
    return inserted.length > 0;
  }
}
