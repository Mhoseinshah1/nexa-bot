import { and, eq, sql } from 'drizzle-orm';
import type { TenantContext, UserId } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { payments, services } from '../../../../infrastructure/persistence/schema.js';
import type {
  CustomerCounters,
  CustomerCountersReader,
} from '../application/customer-counters-ports.js';

export class DrizzleCustomerCountersReader implements CustomerCountersReader {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async counters(
    scope: TenantContext,
    customerId: UserId,
    tx?: unknown,
  ): Promise<CustomerCounters> {
    const tenantId = requireTenantId(scope);
    const [serviceRow] = await this.exec(tx)
      .select({ total: sql<number>`count(*)::int` })
      .from(services)
      .where(and(eq(services.tenantId, tenantId), eq(services.customerId, customerId)));
    const [paymentRow] = await this.exec(tx)
      .select({ total: sql<number>`count(*)::int` })
      .from(payments)
      .where(
        and(
          eq(payments.tenantId, tenantId),
          eq(payments.customerId, customerId),
          eq(payments.state, 'CONFIRMED'),
        ),
      );
    return {
      services: Number(serviceRow?.total ?? 0),
      paidInvoices: Number(paymentRow?.total ?? 0),
    };
  }
}
