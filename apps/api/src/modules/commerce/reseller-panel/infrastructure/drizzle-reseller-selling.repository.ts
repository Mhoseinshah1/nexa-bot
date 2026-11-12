import { and, asc, desc, eq, ilike, isNotNull, isNull, or } from 'drizzle-orm';
import type { ResellerDailyReportKind, TenantContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  resellerClientServices,
  resellerClients,
  resellerPurchaseBatchOrders,
  resellerPurchaseBatches,
  resellerTierTargets,
  resellerWebDailyReports,
  services,
} from '../../../../infrastructure/persistence/schema.js';
import { ScopeBound } from '../../../../infrastructure/persistence/database-scope.js';
import type {
  PendingBatchApplication,
  PurchaseBatchOrderRecord,
  PurchaseBatchRecord,
  ResellerClientRecord,
  ResellerSellingRepository,
  ResellerTierTargetRecord,
} from '../application/selling-ports.js';

type BatchRow = typeof resellerPurchaseBatches.$inferSelect;
type ClientRow = typeof resellerClients.$inferSelect;

function toBatch(row: BatchRow): PurchaseBatchRecord {
  return {
    id: row.id,
    customerId: row.customerId,
    idempotencyKey: row.idempotencyKey,
    productId: row.productId,
    customPanelId: row.customPanelId,
    customVolumeUnits: row.customVolumeUnits,
    customDays: row.customDays,
    title: row.title,
    quantity: row.quantity,
    usernameMode: row.usernameMode as 'AUTOMATIC' | 'CUSTOM',
    customUsername: row.customUsername,
    clientId: row.clientId,
    note: row.note,
    createdAt: row.createdAt,
    confirmedAt: row.confirmedAt,
  };
}

function toClient(row: ClientRow): ResellerClientRecord {
  return {
    id: row.id,
    customerId: row.customerId,
    name: row.name,
    contact: row.contact,
    note: row.note,
    createdAt: row.createdAt,
    archivedAt: row.archivedAt,
  };
}

/** `%`, `_` and `\` taken literally in an ILIKE search. */
function likeLiteral(text: string): string {
  return `%${text.replace(/[\\%_]/gu, (char) => `\\${char}`)}%`;
}

/** PR-5 — the reseller panel's selling rows in PostgreSQL, every statement in its tenant. */
@ScopeBound()
export class DrizzleResellerSellingRepository implements ResellerSellingRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  // --- purchase batches ----------------------------------------------------------------

  async findBatchByKey(
    scope: TenantContext,
    customerId: string,
    idempotencyKey: string,
    tx?: unknown,
  ): Promise<PurchaseBatchRecord | null> {
    const [row] = await this.exec(tx)
      .select()
      .from(resellerPurchaseBatches)
      .where(
        and(
          eq(resellerPurchaseBatches.tenantId, requireTenantId(scope)),
          eq(resellerPurchaseBatches.customerId, customerId),
          eq(resellerPurchaseBatches.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return row === undefined ? null : toBatch(row);
  }

  async findBatch(
    scope: TenantContext,
    customerId: string,
    batchId: string,
    tx?: unknown,
  ): Promise<PurchaseBatchRecord | null> {
    const [row] = await this.exec(tx)
      .select()
      .from(resellerPurchaseBatches)
      .where(
        and(
          eq(resellerPurchaseBatches.tenantId, requireTenantId(scope)),
          eq(resellerPurchaseBatches.customerId, customerId),
          eq(resellerPurchaseBatches.id, batchId),
        ),
      )
      .limit(1);
    return row === undefined ? null : toBatch(row);
  }

  async insertBatch(
    scope: TenantContext,
    row: Omit<PurchaseBatchRecord, 'confirmedAt'>,
    tx: unknown,
  ): Promise<boolean> {
    const inserted = await this.exec(tx)
      .insert(resellerPurchaseBatches)
      .values({
        id: row.id,
        tenantId: requireTenantId(scope),
        customerId: row.customerId,
        idempotencyKey: row.idempotencyKey,
        productId: row.productId,
        customPanelId: row.customPanelId,
        customVolumeUnits: row.customVolumeUnits,
        customDays: row.customDays,
        title: row.title,
        quantity: row.quantity,
        usernameMode: row.usernameMode,
        customUsername: row.customUsername,
        clientId: row.clientId,
        note: row.note,
        createdAt: row.createdAt,
      })
      .onConflictDoNothing()
      .returning({ id: resellerPurchaseBatches.id });
    return inserted.length > 0;
  }

  async insertBatchOrder(
    scope: TenantContext,
    row: {
      readonly batchId: string;
      readonly position: number;
      readonly orderId: string;
      readonly customerId: string;
    },
    tx?: unknown,
  ): Promise<void> {
    await this.exec(tx)
      .insert(resellerPurchaseBatchOrders)
      .values({ tenantId: requireTenantId(scope), ...row })
      .onConflictDoNothing();
  }

  async batchOrders(
    scope: TenantContext,
    batchId: string,
    tx?: unknown,
  ): Promise<readonly PurchaseBatchOrderRecord[]> {
    return this.exec(tx)
      .select({
        position: resellerPurchaseBatchOrders.position,
        orderId: resellerPurchaseBatchOrders.orderId,
        appliedAt: resellerPurchaseBatchOrders.appliedAt,
      })
      .from(resellerPurchaseBatchOrders)
      .where(
        and(
          eq(resellerPurchaseBatchOrders.tenantId, requireTenantId(scope)),
          eq(resellerPurchaseBatchOrders.batchId, batchId),
        ),
      )
      .orderBy(asc(resellerPurchaseBatchOrders.position));
  }

  async markBatchConfirmed(
    scope: TenantContext,
    input: { readonly batchId: string; readonly customerId: string; readonly now: Date },
    tx: unknown,
  ): Promise<boolean> {
    const updated = await this.exec(tx)
      .update(resellerPurchaseBatches)
      .set({ confirmedAt: input.now })
      .where(
        and(
          eq(resellerPurchaseBatches.tenantId, requireTenantId(scope)),
          eq(resellerPurchaseBatches.id, input.batchId),
          eq(resellerPurchaseBatches.customerId, input.customerId),
          isNull(resellerPurchaseBatches.confirmedAt),
        ),
      )
      .returning({ id: resellerPurchaseBatches.id });
    return updated.length > 0;
  }

  async pendingApplications(
    scope: TenantContext,
    customerId: string,
  ): Promise<readonly PendingBatchApplication[]> {
    const tenantId = requireTenantId(scope);
    return this.db
      .select({
        batchId: resellerPurchaseBatchOrders.batchId,
        position: resellerPurchaseBatchOrders.position,
        serviceId: services.id,
        clientId: resellerPurchaseBatches.clientId,
        note: resellerPurchaseBatches.note,
      })
      .from(resellerPurchaseBatchOrders)
      .innerJoin(
        resellerPurchaseBatches,
        and(
          eq(resellerPurchaseBatches.tenantId, resellerPurchaseBatchOrders.tenantId),
          eq(resellerPurchaseBatches.id, resellerPurchaseBatchOrders.batchId),
        ),
      )
      .innerJoin(
        services,
        and(
          eq(services.tenantId, resellerPurchaseBatchOrders.tenantId),
          eq(services.orderId, resellerPurchaseBatchOrders.orderId),
          // Still the reseller's own: a service transferred away takes no label.
          eq(services.customerId, customerId),
        ),
      )
      .where(
        and(
          eq(resellerPurchaseBatchOrders.tenantId, tenantId),
          eq(resellerPurchaseBatchOrders.customerId, customerId),
          eq(resellerPurchaseBatches.customerId, customerId),
          isNull(resellerPurchaseBatchOrders.appliedAt),
          or(isNotNull(resellerPurchaseBatches.clientId), isNotNull(resellerPurchaseBatches.note)),
        ),
      )
      .limit(200);
  }

  async markApplied(
    scope: TenantContext,
    input: { readonly batchId: string; readonly position: number; readonly now: Date },
    tx: unknown,
  ): Promise<boolean> {
    const updated = await this.exec(tx)
      .update(resellerPurchaseBatchOrders)
      .set({ appliedAt: input.now })
      .where(
        and(
          eq(resellerPurchaseBatchOrders.tenantId, requireTenantId(scope)),
          eq(resellerPurchaseBatchOrders.batchId, input.batchId),
          eq(resellerPurchaseBatchOrders.position, input.position),
          isNull(resellerPurchaseBatchOrders.appliedAt),
        ),
      )
      .returning({ position: resellerPurchaseBatchOrders.position });
    return updated.length > 0;
  }

  // --- clients book --------------------------------------------------------------------

  async listClients(
    scope: TenantContext,
    customerId: string,
    query: { readonly archived: boolean; readonly q?: string },
  ): Promise<readonly ResellerClientRecord[]> {
    const search =
      query.q === undefined || query.q.length === 0
        ? undefined
        : or(
            ilike(resellerClients.name, likeLiteral(query.q)),
            ilike(resellerClients.contact, likeLiteral(query.q)),
          );
    const rows = await this.db
      .select()
      .from(resellerClients)
      .where(
        and(
          eq(resellerClients.tenantId, requireTenantId(scope)),
          eq(resellerClients.customerId, customerId),
          query.archived
            ? isNotNull(resellerClients.archivedAt)
            : isNull(resellerClients.archivedAt),
          search,
        ),
      )
      .orderBy(desc(resellerClients.createdAt), desc(resellerClients.id))
      .limit(1000);
    return rows.map(toClient);
  }

  async findClient(
    scope: TenantContext,
    customerId: string,
    clientId: string,
    tx?: unknown,
  ): Promise<ResellerClientRecord | null> {
    const [row] = await this.exec(tx)
      .select()
      .from(resellerClients)
      .where(
        and(
          eq(resellerClients.tenantId, requireTenantId(scope)),
          eq(resellerClients.id, clientId),
          // The ownership filter: another reseller's client is not found.
          eq(resellerClients.customerId, customerId),
        ),
      )
      .limit(1);
    return row === undefined ? null : toClient(row);
  }

  async insertClient(
    scope: TenantContext,
    row: {
      readonly id: string;
      readonly customerId: string;
      readonly name: string;
      readonly contact: string | null;
      readonly note: string | null;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<void> {
    await this.exec(tx)
      .insert(resellerClients)
      .values({
        id: row.id,
        tenantId: requireTenantId(scope),
        customerId: row.customerId,
        name: row.name,
        contact: row.contact,
        note: row.note,
        createdAt: row.now,
        updatedAt: row.now,
      });
  }

  async updateClient(
    scope: TenantContext,
    row: {
      readonly id: string;
      readonly customerId: string;
      readonly name: string;
      readonly contact: string | null;
      readonly note: string | null;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean> {
    const updated = await this.exec(tx)
      .update(resellerClients)
      .set({ name: row.name, contact: row.contact, note: row.note, updatedAt: row.now })
      .where(
        and(
          eq(resellerClients.tenantId, requireTenantId(scope)),
          eq(resellerClients.id, row.id),
          eq(resellerClients.customerId, row.customerId),
          isNull(resellerClients.archivedAt),
        ),
      )
      .returning({ id: resellerClients.id });
    return updated.length > 0;
  }

  async archiveClient(
    scope: TenantContext,
    input: { readonly id: string; readonly customerId: string; readonly now: Date },
    tx: unknown,
  ): Promise<boolean> {
    const updated = await this.exec(tx)
      .update(resellerClients)
      .set({ archivedAt: input.now, updatedAt: input.now })
      .where(
        and(
          eq(resellerClients.tenantId, requireTenantId(scope)),
          eq(resellerClients.id, input.id),
          eq(resellerClients.customerId, input.customerId),
          isNull(resellerClients.archivedAt),
        ),
      )
      .returning({ id: resellerClients.id });
    return updated.length > 0;
  }

  async assignmentsOf(
    scope: TenantContext,
    customerId: string,
  ): Promise<ReadonlyMap<string, string>> {
    const rows = await this.db
      .select({
        serviceId: resellerClientServices.serviceId,
        clientId: resellerClientServices.clientId,
      })
      .from(resellerClientServices)
      .where(
        and(
          eq(resellerClientServices.tenantId, requireTenantId(scope)),
          eq(resellerClientServices.customerId, customerId),
        ),
      );
    return new Map(rows.map((row) => [row.serviceId, row.clientId]));
  }

  async assignedTo(scope: TenantContext, serviceId: string, tx?: unknown): Promise<string | null> {
    const [row] = await this.exec(tx)
      .select({ clientId: resellerClientServices.clientId })
      .from(resellerClientServices)
      .where(
        and(
          eq(resellerClientServices.tenantId, requireTenantId(scope)),
          eq(resellerClientServices.serviceId, serviceId),
        ),
      )
      .limit(1);
    return row?.clientId ?? null;
  }

  async assign(
    scope: TenantContext,
    row: {
      readonly serviceId: string;
      readonly clientId: string;
      readonly customerId: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<void> {
    await this.exec(tx)
      .insert(resellerClientServices)
      .values({
        tenantId: requireTenantId(scope),
        serviceId: row.serviceId,
        clientId: row.clientId,
        customerId: row.customerId,
        assignedAt: row.now,
      })
      .onConflictDoUpdate({
        target: [resellerClientServices.tenantId, resellerClientServices.serviceId],
        set: { clientId: row.clientId, customerId: row.customerId, assignedAt: row.now },
      });
  }

  async unassign(
    scope: TenantContext,
    input: { readonly serviceId: string; readonly customerId: string },
    tx: unknown,
  ): Promise<boolean> {
    const deleted = await this.exec(tx)
      .delete(resellerClientServices)
      .where(
        and(
          eq(resellerClientServices.tenantId, requireTenantId(scope)),
          eq(resellerClientServices.serviceId, input.serviceId),
          eq(resellerClientServices.customerId, input.customerId),
        ),
      )
      .returning({ serviceId: resellerClientServices.serviceId });
    return deleted.length > 0;
  }

  // --- daily reports and tier targets --------------------------------------------------

  async insertDailyReport(
    scope: TenantContext,
    row: {
      readonly id: string;
      readonly customerId: string;
      readonly kind: ResellerDailyReportKind;
      readonly day: string;
      readonly facts: Record<string, unknown>;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<string | null> {
    const inserted = await this.exec(tx)
      .insert(resellerWebDailyReports)
      .values({
        id: row.id,
        tenantId: requireTenantId(scope),
        customerId: row.customerId,
        kind: row.kind,
        day: row.day,
        facts: row.facts,
        createdAt: row.now,
      })
      .onConflictDoNothing()
      .returning({ id: resellerWebDailyReports.id });
    return inserted[0]?.id ?? null;
  }

  async findTierTarget(
    scope: TenantContext,
    tierId: string,
  ): Promise<ResellerTierTargetRecord | null> {
    const [row] = await this.db
      .select()
      .from(resellerTierTargets)
      .where(
        and(
          eq(resellerTierTargets.tenantId, requireTenantId(scope)),
          eq(resellerTierTargets.tierId, tierId),
        ),
      )
      .limit(1);
    if (row === undefined) return null;
    return {
      tierId: row.tierId,
      kind: row.kind as 'COUNT' | 'AMOUNT',
      count: row.targetCount,
      amountMinor: row.targetAmountMinor,
      currency: row.targetCurrency,
    };
  }

  async saveTierTarget(
    scope: TenantContext,
    input: {
      readonly tierId: string;
      readonly target: Omit<ResellerTierTargetRecord, 'tierId'> | null;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    if (input.target === null) {
      await this.exec(tx)
        .delete(resellerTierTargets)
        .where(
          and(
            eq(resellerTierTargets.tenantId, tenantId),
            eq(resellerTierTargets.tierId, input.tierId),
          ),
        );
      return;
    }
    const values = {
      kind: input.target.kind,
      targetCount: input.target.count,
      targetAmountMinor: input.target.amountMinor,
      targetCurrency: input.target.currency,
      updatedAt: input.now,
    };
    await this.exec(tx)
      .insert(resellerTierTargets)
      .values({ tenantId, tierId: input.tierId, ...values })
      .onConflictDoUpdate({
        target: [resellerTierTargets.tenantId, resellerTierTargets.tierId],
        set: values,
      });
  }
}
