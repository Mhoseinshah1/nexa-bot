import type { TenantContext, UserId } from '@nexa/contracts';

/**
 * The counts the wallet screen shows (customer UX completion §E), read from the rows
 * that ARE the facts: services ever created for the customer, and CONFIRMED payments.
 * Never a counter column — a column is a second answer that drifts from the rows.
 */
export interface CustomerCounters {
  readonly services: number;
  readonly paidInvoices: number;
}

export interface CustomerCountersReader {
  counters(scope: TenantContext, customerId: UserId, tx?: unknown): Promise<CustomerCounters>;
}
