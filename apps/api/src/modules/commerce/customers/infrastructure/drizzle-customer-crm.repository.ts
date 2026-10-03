import { and, asc, desc, eq, ne, sql, type SQL } from 'drizzle-orm';
import type { CustomerTagColor, TenantContext, UserId } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  customerNotes,
  customerTagAssignments,
  customerTags,
} from '../../../../infrastructure/persistence/schema.js';
import type {
  CustomerAssignedTagRecord,
  CustomerCrmRepository,
  CustomerNoteCursor,
  CustomerNotePage,
  CustomerNoteRecord,
  CustomerTagRecord,
} from '../application/customer-crm-ports.js';

/**
 * The advisory-lock class for a tenant's tag CATALOGUE writes ("TG"). One class per purpose,
 * as every lock here has; assignments never take it.
 */
export const CUSTOMER_TAG_CATALOGUE_LOCK_CLASS = 0x5447;

/**
 * Customer notes and tags, in PostgreSQL. Every statement names the tenant in its WHERE
 * clause, including the primary-key lookups, so another tenant's row never leaves the
 * database (`drizzle-customer.repository.ts` says why that is not redundant).
 */
export class DrizzleCustomerCrmRepository implements CustomerCrmRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async lockCatalogue(scope: TenantContext, tx: unknown): Promise<void> {
    const tenantId = requireTenantId(scope);
    await this.exec(tx).execute(
      sql`SELECT pg_advisory_xact_lock(${CUSTOMER_TAG_CATALOGUE_LOCK_CLASS}, hashtext(${tenantId}))`,
    );
  }

  async countTags(scope: TenantContext, tx: unknown): Promise<number> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ n: sql<number>`count(*)::int` })
      .from(customerTags)
      .where(eq(customerTags.tenantId, tenantId));
    return rows[0]?.n ?? 0;
  }

  async listTags(scope: TenantContext, tx?: unknown): Promise<readonly CustomerTagRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(customerTags)
      .where(eq(customerTags.tenantId, tenantId))
      .orderBy(...catalogueOrder());
    return rows.map(toTag);
  }

  async findTag(
    scope: TenantContext,
    id: string,
    tx?: unknown,
    lock?: 'UPDATE' | 'SHARE',
  ): Promise<CustomerTagRecord | null> {
    const tenantId = requireTenantId(scope);
    const query = this.exec(tx)
      .select()
      .from(customerTags)
      .where(and(eq(customerTags.tenantId, tenantId), eq(customerTags.id, id)));
    const rows =
      lock === 'UPDATE'
        ? await query.for('update')
        : lock === 'SHARE'
          ? await query.for('share')
          : await query;
    const row = rows[0];
    return row === undefined ? null : toTag(row);
  }

  async activeLabelTaken(
    scope: TenantContext,
    label: string,
    exceptId: string | null,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const conditions: SQL[] = [
      eq(customerTags.tenantId, tenantId),
      sql`${customerTags.archivedAt} IS NULL`,
      // The unique index's own expression, so this read and the index agree on "same name".
      sql`lower(${customerTags.label}) = lower(${label})`,
    ];
    if (exceptId !== null) conditions.push(ne(customerTags.id, exceptId));
    const rows = await this.exec(tx)
      .select({ id: customerTags.id })
      .from(customerTags)
      .where(and(...conditions))
      .limit(1);
    return rows.length > 0;
  }

  async insertTag(
    scope: TenantContext,
    tag: {
      readonly id: string;
      readonly label: string;
      readonly color: CustomerTagColor | null;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<CustomerTagRecord> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(customerTags)
      .values({
        id: tag.id,
        tenantId,
        label: tag.label,
        color: tag.color,
        createdAt: tag.now,
        updatedAt: tag.now,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error('customer_tags insert returned no row');
    return toTag(row);
  }

  async updateTag(
    scope: TenantContext,
    id: string,
    change: { readonly label: string; readonly color: CustomerTagColor | null; readonly now: Date },
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(customerTags)
      .set({ label: change.label, color: change.color, updatedAt: change.now })
      .where(
        and(
          eq(customerTags.tenantId, tenantId),
          eq(customerTags.id, id),
          // A write that changes nothing is reported as such, not as success.
          sql`(${customerTags.label}, ${customerTags.color}) IS DISTINCT FROM (${change.label}::text, ${change.color}::text)`,
        ),
      )
      .returning({ id: customerTags.id });
    return rows.length > 0;
  }

  async setArchived(
    scope: TenantContext,
    id: string,
    archived: boolean,
    now: Date,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(customerTags)
      .set({ archivedAt: archived ? now : null, updatedAt: now })
      .where(
        and(
          eq(customerTags.tenantId, tenantId),
          eq(customerTags.id, id),
          archived
            ? sql`${customerTags.archivedAt} IS NULL`
            : sql`${customerTags.archivedAt} IS NOT NULL`,
        ),
      )
      .returning({ id: customerTags.id });
    return rows.length > 0;
  }

  async assign(
    scope: TenantContext,
    input: {
      readonly customerId: UserId;
      readonly tagId: string;
      readonly adminId: string | null;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(customerTagAssignments)
      .values({
        tenantId,
        customerId: input.customerId,
        tagId: input.tagId,
        assignedByAdminId: input.adminId,
        assignedAt: input.now,
      })
      .onConflictDoNothing()
      .returning({ tagId: customerTagAssignments.tagId });
    return rows.length > 0;
  }

  async unassign(
    scope: TenantContext,
    customerId: UserId,
    tagId: string,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .delete(customerTagAssignments)
      .where(
        and(
          eq(customerTagAssignments.tenantId, tenantId),
          eq(customerTagAssignments.customerId, customerId),
          eq(customerTagAssignments.tagId, tagId),
        ),
      )
      .returning({ tagId: customerTagAssignments.tagId });
    return rows.length > 0;
  }

  async tagsOf(
    scope: TenantContext,
    customerId: UserId,
    tx?: unknown,
  ): Promise<readonly CustomerAssignedTagRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ tag: customerTags, assignedAt: customerTagAssignments.assignedAt })
      .from(customerTagAssignments)
      .innerJoin(
        customerTags,
        and(
          eq(customerTags.tenantId, customerTagAssignments.tenantId),
          eq(customerTags.id, customerTagAssignments.tagId),
        ),
      )
      .where(
        and(
          eq(customerTagAssignments.tenantId, tenantId),
          eq(customerTagAssignments.customerId, customerId),
        ),
      )
      .orderBy(...catalogueOrder());
    return rows.map((row) => ({ ...toTag(row.tag), assignedAt: row.assignedAt }));
  }

  async insertNote(
    scope: TenantContext,
    note: {
      readonly id: string;
      readonly customerId: UserId;
      readonly body: string;
      readonly authorAdminId: string | null;
      readonly authorLabel: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<CustomerNoteRecord> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(customerNotes)
      .values({
        id: note.id,
        tenantId,
        customerId: note.customerId,
        body: note.body,
        authorAdminId: note.authorAdminId,
        authorLabel: note.authorLabel,
        createdAt: note.now,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error('customer_notes insert returned no row');
    return toNote(row);
  }

  async findNote(
    scope: TenantContext,
    customerId: UserId,
    id: string,
  ): Promise<CustomerNoteRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select()
      .from(customerNotes)
      .where(
        and(
          eq(customerNotes.tenantId, tenantId),
          eq(customerNotes.customerId, customerId),
          eq(customerNotes.id, id),
        ),
      );
    const row = rows[0];
    return row === undefined ? null : toNote(row);
  }

  async notesOf(
    scope: TenantContext,
    customerId: UserId,
    limit: number,
    cursor: CustomerNoteCursor | null,
  ): Promise<CustomerNotePage> {
    const tenantId = requireTenantId(scope);
    const conditions: SQL[] = [
      eq(customerNotes.tenantId, tenantId),
      eq(customerNotes.customerId, customerId),
    ];
    if (cursor !== null) {
      conditions.push(
        sql`(${customerNotes.createdAt}, ${customerNotes.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const rows = await this.db
      .select({
        note: customerNotes,
        // The cursor's half of the key in PostgreSQL's own text, never a truncating `Date`.
        createdAtText: sql<string>`to_char(${customerNotes.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(customerNotes)
      .where(and(...conditions))
      .orderBy(desc(customerNotes.createdAt), desc(customerNotes.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => toNote(row.note)),
      nextCursor:
        rows.length > limit && last !== undefined
          ? { createdAt: last.createdAtText, id: last.note.id }
          : null,
    };
  }
}

/** Active before archived, then the label as PostgreSQL folds it, then the id: total. */
function catalogueOrder(): SQL[] {
  return [
    sql`(${customerTags.archivedAt} IS NOT NULL)`,
    sql`lower(${customerTags.label})`,
    asc(customerTags.id),
  ];
}

function toTag(row: typeof customerTags.$inferSelect): CustomerTagRecord {
  return {
    id: row.id,
    label: row.label,
    color: row.color as CustomerTagColor | null,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toNote(row: typeof customerNotes.$inferSelect): CustomerNoteRecord {
  return {
    id: row.id,
    customerId: row.customerId as UserId,
    body: row.body,
    authorAdminId: row.authorAdminId,
    authorLabel: row.authorLabel,
    createdAt: row.createdAt,
  };
}
