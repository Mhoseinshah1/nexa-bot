import { and, asc, eq, getTableColumns, isNotNull, sql, type SQL } from 'drizzle-orm';
import { money } from '@nexa/contracts';
import type {
  CurrencyCode,
  ServiceAddonId,
  ServiceAddonKind,
  ServiceAddonStatus,
  TenantContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { serviceAddons } from '../../../../infrastructure/persistence/schema.js';
import type {
  ServiceAddonCursor,
  ServiceAddonDraft,
  ServiceAddonEdit,
  ServiceAddonPage,
  ServiceAddonRecord,
  ServiceAddonRepository,
  ServiceAddonSearch,
} from '../application/addon-ports.js';

/**
 * Service add-ons, in PostgreSQL.
 *
 * Every query carries `eq(serviceAddons.tenantId, …)`, the primary-key lookups
 * included, for the reason the product repository states: a primary-key lookup without
 * the tenant returns another tenant's row and leaves the caller holding something it
 * should never have seen.
 */
export class DrizzleServiceAddonRepository implements ServiceAddonRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async create(
    scope: TenantContext,
    input: { readonly id: ServiceAddonId; readonly draft: ServiceAddonDraft; readonly now: Date },
    tx?: unknown,
  ): Promise<ServiceAddonRecord> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(serviceAddons)
      .values({
        id: input.id,
        tenantId,
        kind: input.draft.kind,
        ...columnsFor(input.draft),
        // INACTIVE, stated rather than left to the default, so the rule is visible where
        // the row is made: an add-on becomes purchasable through its own command.
        status: 'INACTIVE',
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error('service_addons insert returned no row.');
    return toRecord(row);
  }

  async findById(
    scope: TenantContext,
    id: ServiceAddonId,
    tx?: unknown,
  ): Promise<ServiceAddonRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(serviceAddons)
      .where(and(eq(serviceAddons.tenantId, tenantId), eq(serviceAddons.id, id)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async list(
    scope: TenantContext,
    search: ServiceAddonSearch,
    limit: number,
    cursor: ServiceAddonCursor | null,
    tx?: unknown,
  ): Promise<ServiceAddonPage> {
    const tenantId = requireTenantId(scope);
    const conditions: SQL[] = [eq(serviceAddons.tenantId, tenantId)];
    if (search.kind !== undefined) conditions.push(eq(serviceAddons.kind, search.kind));
    if (search.status !== undefined) conditions.push(eq(serviceAddons.status, search.status));
    if (cursor !== null) {
      conditions.push(
        sql`(${serviceAddons.createdAt}, ${serviceAddons.id}) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
      );
    }

    const rows = await this.exec(tx)
      .select({
        ...getTableColumns(serviceAddons),
        createdAtText: sql<string>`to_char(${serviceAddons.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(serviceAddons)
      .where(and(...conditions))
      .orderBy(asc(serviceAddons.createdAt), asc(serviceAddons.id))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toRecord),
      nextCursor:
        rows.length > limit && last !== undefined
          ? { createdAt: last.createdAtText, id: last.id as ServiceAddonId }
          : null,
    };
  }

  async update(
    scope: TenantContext,
    id: ServiceAddonId,
    edit: ServiceAddonEdit,
    now: Date,
    tx?: unknown,
  ): Promise<ServiceAddonRecord | null> {
    const tenantId = requireTenantId(scope);
    /*
     * `kind` is not in `columnsFor`'s output for an edit, and that is the enforcement.
     *
     * `ServiceAddonEdit` omits it at the type level and this UPDATE never names the
     * column, so there is no path — typed or untyped — by which an edit changes what an
     * add-on IS. Every `service_commercial_actions` row that already bought this one is
     * append-only evidence describing a quantity in its unit.
     */
    const rows = await this.exec(tx)
      .update(serviceAddons)
      .set({ ...columnsFor(edit), updatedAt: now })
      .where(and(eq(serviceAddons.tenantId, tenantId), eq(serviceAddons.id, id)))
      .returning();
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async setStatus(
    scope: TenantContext,
    id: ServiceAddonId,
    from: ServiceAddonStatus,
    to: ServiceAddonStatus,
    now: Date,
    tx?: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(serviceAddons)
      .set({ status: to, updatedAt: now })
      .where(
        and(
          eq(serviceAddons.tenantId, tenantId),
          eq(serviceAddons.id, id),
          eq(serviceAddons.status, from),
        ),
      )
      .returning({ id: serviceAddons.id });
    return rows.length > 0;
  }

  /**
   * ACTIVE and priced, of one kind, in the operator's order.
   *
   * Both predicates are in the WHERE clause so an unpriced add-on never leaves the
   * database — `catalog.ts` is explicit that an absent price means unsellable rather
   * than free, and a surface handed one would have to invent something to render beside
   * it. There is no panel predicate here on purpose: whether the SERVICE's panel can
   * perform the operation is a different question, asked by `decideOperability` against
   * that service's own panel, and an add-on is not bound to a panel at all.
   */
  async listOfferable(
    scope: TenantContext,
    kind: ServiceAddonKind,
    limit: number,
    tx?: unknown,
  ): Promise<{ readonly items: readonly ServiceAddonRecord[]; readonly hasMore: boolean }> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(serviceAddons)
      .where(
        and(
          eq(serviceAddons.tenantId, tenantId),
          eq(serviceAddons.kind, kind),
          eq(serviceAddons.status, 'ACTIVE'),
          isNotNull(serviceAddons.priceAmount),
        ),
      )
      .orderBy(asc(serviceAddons.sortOrder), asc(serviceAddons.createdAt), asc(serviceAddons.id))
      .limit(limit + 1);

    return { items: rows.slice(0, limit).map(toRecord), hasMore: rows.length > limit };
  }
}

/** The draft's mutable fields as columns. One place, so create and update agree. */
function columnsFor(draft: ServiceAddonEdit) {
  return {
    title: draft.title,
    sortOrder: draft.sortOrder,
    trafficBytes: draft.specification.trafficBytes,
    durationDays: draft.specification.durationDays,
    // Both halves of the price, or both null, written from ONE nullable value.
    priceAmount: draft.price === null ? null : draft.price.amountMinor,
    priceCurrency: draft.price === null ? null : draft.price.currency,
  };
}

function toRecord(row: typeof serviceAddons.$inferSelect): ServiceAddonRecord {
  const kind = row.kind as ServiceAddonKind;
  return {
    id: row.id as ServiceAddonId,
    kind,
    title: row.title,
    status: row.status as ServiceAddonStatus,
    sortOrder: row.sortOrder,
    /*
     * Read back as the union its kind decides, which is what
     * `service_addons_amount_matches_kind` guarantees: the field this kind reads is
     * NOT NULL and positive, and the other is NULL. The narrowing below therefore
     * describes the constraint rather than defending against it — and it throws rather
     * than defaulting, because a zero substituted here would be `UNLIMITED_TRAFFIC_BYTES`
     * and would offer a customer an unlimited allowance for the price of a package.
     */
    specification: specificationOf(row, kind),
    price:
      row.priceAmount === null || row.priceCurrency === null
        ? null
        : money(row.priceAmount, row.priceCurrency as CurrencyCode),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function specificationOf(row: typeof serviceAddons.$inferSelect, kind: ServiceAddonKind) {
  if (kind === 'ADD_TRAFFIC') {
    if (row.trafficBytes === null) {
      throw new Error(`add-on ${row.id} is ADD_TRAFFIC with no traffic amount.`);
    }
    return { kind, trafficBytes: row.trafficBytes, durationDays: null } as const;
  }
  if (row.durationDays === null) {
    throw new Error(`add-on ${row.id} is ADD_TIME with no duration.`);
  }
  return { kind, trafficBytes: null, durationDays: row.durationDays } as const;
}
