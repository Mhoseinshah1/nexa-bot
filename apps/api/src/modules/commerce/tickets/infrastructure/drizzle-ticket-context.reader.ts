import { and, eq } from 'drizzle-orm';
import type { TenantContext, UserId } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { orders, payments, services } from '../../../../infrastructure/persistence/schema.js';
import type { TicketContextReader } from '../application/ports.js';

/**
 * Who owns a service, an order or a payment — the one question linking a ticket's context
 * asks, and nothing else. Tenant-scoped: another tenant's id is "no owner".
 */
export class DrizzleTicketContextReader implements TicketContextReader {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async ownerOf(
    scope: TenantContext,
    kind: 'SERVICE' | 'ORDER' | 'PAYMENT',
    id: string,
    tx?: unknown,
  ): Promise<UserId | null> {
    const tenantId = requireTenantId(scope);
    const db = this.exec(tx);
    const rows =
      kind === 'SERVICE'
        ? await db
            .select({ customerId: services.customerId })
            .from(services)
            .where(and(eq(services.tenantId, tenantId), eq(services.id, id)))
            .limit(1)
        : kind === 'ORDER'
          ? await db
              .select({ customerId: orders.customerId })
              .from(orders)
              .where(and(eq(orders.tenantId, tenantId), eq(orders.id, id)))
              .limit(1)
          : await db
              .select({ customerId: payments.customerId })
              .from(payments)
              .where(and(eq(payments.tenantId, tenantId), eq(payments.id, id)))
              .limit(1);
    const row = rows[0];
    return row === undefined ? null : (row.customerId as UserId);
  }
}
