import {
  COMMERCE_ERROR_CODES,
  CUSTOMER_TIMELINE_LIMIT,
  CUSTOMER_WORKSPACE_COUNT_CAP,
  CUSTOMER_WORKSPACE_LATEST_LIMIT,
  CUSTOMER_WORKSPACE_PERMISSIONS,
  errors,
  type CustomerWorkspaceSection,
  type OrderPurpose,
  type OrderState,
  type PaymentMethod,
  type PaymentState,
  userIdSchema,
  type ActorContext,
  type PermissionKey,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import type {
  AuditHistoryReader,
  AuditHistoryRecord,
} from '../../../platform/audit/application/ports.js';
import { CUSTOMER_VIEW_PERMISSION } from './customer.service.js';
import type { CustomerRepository } from './ports.js';

export interface OrderAggregateRow {
  readonly state: string;
  readonly purpose: string;
  readonly currency: string;
  readonly count: number;
  readonly total: bigint;
  readonly discount: bigint;
}

export interface PaymentAggregateRow {
  readonly state: string;
  readonly currency: string;
  readonly count: number;
  readonly total: bigint;
}

export interface LedgerAggregateRow {
  readonly reason: string;
  readonly direction: string;
  readonly currency: string;
  readonly count: number;
  readonly total: bigint;
}

/** One customer's rows, grouped. Each method reads one table and nothing else. */
export interface CustomerInsightReader {
  orders(scope: TenantContext, customerId: UserId): Promise<readonly OrderAggregateRow[]>;
  payments(scope: TenantContext, customerId: UserId): Promise<readonly PaymentAggregateRow[]>;
  ledger(scope: TenantContext, customerId: UserId): Promise<readonly LedgerAggregateRow[]>;
  services(
    scope: TenantContext,
    customerId: UserId,
  ): Promise<readonly { readonly state: string; readonly count: number }[]>;
}

/** One of the customer's newest orders, as the workspace lists it. */
export interface WorkspaceOrderRow {
  readonly id: string;
  readonly lineTitle: string;
  readonly purpose: OrderPurpose;
  readonly state: OrderState;
  readonly totalAmount: bigint;
  readonly currency: string;
  readonly createdAt: Date;
}

/** One of the customer's newest payments, as the workspace lists it. */
export interface WorkspacePaymentRow {
  readonly id: string;
  readonly reference: string;
  readonly method: PaymentMethod;
  readonly state: PaymentState;
  readonly amount: bigint;
  readonly currency: string;
  readonly createdAt: Date;
}

/**
 * Customer 360's workspace reads (roadmap B5). Every count reads at most `cap` rows — the
 * work is bounded, not only the answer — and every list is newest first, at most `limit`.
 * Each is the predicate the page it deep-links to filters by, narrowed to one customer.
 */
export interface CustomerWorkspaceReader {
  /** OPEN or WAITING_FOR_SUPPORT; and every status but CLOSED. */
  tickets(
    scope: TenantContext,
    customerId: UserId,
    cap: number,
  ): Promise<{ readonly awaitingSupport: number; readonly open: number }>;
  /** Business conversations with this customer in HANDOFF_REQUIRED. */
  businessHandoffs(scope: TenantContext, customerId: UserId, cap: number): Promise<number>;
  unknownPayments(scope: TenantContext, customerId: UserId, cap: number): Promise<number>;
  unreconciledServices(scope: TenantContext, customerId: UserId, cap: number): Promise<number>;
  latestOrders(
    scope: TenantContext,
    customerId: UserId,
    limit: number,
  ): Promise<readonly WorkspaceOrderRow[]>;
  latestPayments(
    scope: TenantContext,
    customerId: UserId,
    limit: number,
  ): Promise<readonly WorkspacePaymentRow[]>;
}

export interface CustomerWorkspace {
  readonly tickets: { readonly awaitingSupport: number; readonly open: number } | null;
  readonly businessHandoffs: number | null;
  readonly payments: {
    readonly unknown: number;
    readonly latest: readonly WorkspacePaymentRow[];
  } | null;
  readonly services: { readonly unreconciled: number } | null;
  readonly orders: { readonly latest: readonly WorkspaceOrderRow[] } | null;
}

export interface PerCurrency {
  readonly currency: string;
  readonly count: number;
  readonly amount: bigint;
}

export interface CustomerFinancialSummary {
  readonly orders: {
    readonly purchases: readonly PerCurrency[];
    readonly discounts: readonly PerCurrency[];
    readonly refunded: readonly PerCurrency[];
    readonly awaitingPayment: number;
    readonly orderCount: number;
  } | null;
  readonly payments: {
    readonly confirmed: readonly PerCurrency[];
    readonly pending: number;
    readonly paymentCount: number;
  } | null;
  readonly ledger: readonly LedgerAggregateRow[] | null;
  readonly services: {
    readonly byState: readonly { readonly state: string; readonly count: number }[];
    readonly serviceCount: number;
  } | null;
  /** The permission each null section needed. */
  readonly denied: readonly PermissionKey[];
}

const ORDERS_VIEW: PermissionKey = 'orders.view';
const PAYMENTS_VIEW: PermissionKey = 'payments.view';
const SERVICES_VIEW: PermissionKey = 'services.view';
const AUDIT_VIEW: PermissionKey = 'audit.view';

export interface CustomerInsightDeps {
  readonly reader: CustomerInsightReader & CustomerWorkspaceReader;
  readonly customers: Pick<CustomerRepository, 'findById'>;
  readonly auditHistory: Pick<AuditHistoryReader, 'customerTimeline'>;
  readonly guard: PermissionGuard;
}

/**
 * Customer 360's derived reads (§11.7, §11.10): exact aggregates and the management
 * timeline. Nothing here estimates: every figure is a COUNT or a SUM of stored rows, and a
 * section whose rows the reader may not see is null with the permission named — a page
 * that drew a total its reader was refused would be the total computed somewhere else.
 *
 * - Purchases are orders that reached `PAID` and stayed there (a refunded order is counted
 *   apart), trials excluded — a trial is free by rule (`orders_trial_is_free_check`).
 * - Discounts are each purchase's frozen `discount_amount`.
 * - Payments are `CONFIRMED` principal (`amount`), per currency; a fee is not the
 *   customer's purchase.
 * - The ledger is grouped by reason and direction, which is where cashback, gifts and
 *   commissions are exact — the reason code says which, never a note.
 */
export class CustomerInsightService {
  constructor(private readonly deps: CustomerInsightDeps) {}

  async financialSummary(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
  ): Promise<CustomerFinancialSummary> {
    const customerId = await this.viewable(scope, actor, id);
    const held = await this.deps.guard.permissionsOf(scope, actor);
    const denied: PermissionKey[] = [];
    const may = (permission: PermissionKey) => {
      if (held.has(permission)) return true;
      denied.push(permission);
      return false;
    };

    const [orders, payments, ledger, services] = await Promise.all([
      may(ORDERS_VIEW) ? this.deps.reader.orders(scope, customerId) : null,
      may(PAYMENTS_VIEW) ? this.deps.reader.payments(scope, customerId) : null,
      // The wallet's own read permission (`WALLET_VIEW_PERMISSION` is `users.view`).
      this.deps.reader.ledger(scope, customerId),
      may(SERVICES_VIEW) ? this.deps.reader.services(scope, customerId) : null,
    ]);

    return {
      orders:
        orders === null
          ? null
          : {
              purchases: perCurrency(
                orders.filter((row) => row.state === 'PAID' && row.purpose !== 'TRIAL'),
                (row) => row.total,
              ),
              discounts: perCurrency(
                orders.filter((row) => row.state === 'PAID' && row.purpose !== 'TRIAL'),
                (row) => row.discount,
              ),
              refunded: perCurrency(
                orders.filter((row) => row.state === 'REFUNDED'),
                (row) => row.total,
              ),
              awaitingPayment: sumCount(orders.filter((row) => row.state === 'AWAITING_PAYMENT')),
              orderCount: sumCount(orders),
            },
      payments:
        payments === null
          ? null
          : {
              confirmed: perCurrency(
                payments.filter((row) => row.state === 'CONFIRMED'),
                (row) => row.total,
              ),
              pending: sumCount(payments.filter((row) => row.state === 'PENDING')),
              paymentCount: sumCount(payments),
            },
      ledger,
      services: services === null ? null : { byState: services, serviceCount: sumCount(services) },
      denied,
    };
  }

  /**
   * What about this customer waits for a person, and their newest orders and payments
   * (roadmap B5, `GET /users/:id/workspace`).
   *
   * `users.view` is CHARGED (through `viewable`), as every per-customer read is. Each section
   * is then computed only when the viewer holds the permission of the page it links to
   * (`CUSTOMER_WORKSPACE_PERMISSIONS`), read once through the guard's own resolution rule,
   * and is otherwise null — its query never runs and no denial is recorded, the financial
   * summary's rule. Nothing is disclosed by the omission: a viewer's permission list is
   * already theirs.
   */
  async workspace(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
  ): Promise<CustomerWorkspace> {
    const customerId = await this.viewable(scope, actor, id);
    const held = await this.deps.guard.permissionsOf(scope, actor);
    const may = (section: CustomerWorkspaceSection): boolean =>
      held.has(CUSTOMER_WORKSPACE_PERMISSIONS[section]);
    const reader = this.deps.reader;
    const cap = CUSTOMER_WORKSPACE_COUNT_CAP;
    const limit = CUSTOMER_WORKSPACE_LATEST_LIMIT;

    const [tickets, businessHandoffs, unknown, latestPayments, unreconciled, latestOrders] =
      await Promise.all([
        may('tickets') ? reader.tickets(scope, customerId, cap) : null,
        may('businessHandoffs') ? reader.businessHandoffs(scope, customerId, cap) : null,
        may('payments') ? reader.unknownPayments(scope, customerId, cap) : null,
        may('payments') ? reader.latestPayments(scope, customerId, limit) : null,
        may('services') ? reader.unreconciledServices(scope, customerId, cap) : null,
        may('orders') ? reader.latestOrders(scope, customerId, limit) : null,
      ]);

    return {
      tickets,
      businessHandoffs,
      payments:
        unknown === null || latestPayments === null ? null : { unknown, latest: latestPayments },
      services: unreconciled === null ? null : { unreconciled },
      orders: latestOrders === null ? null : { latest: latestOrders },
    };
  }

  /** The newest management activity on this customer. `audit.view` on top of `users.view`. */
  async timeline(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
  ): Promise<readonly (AuditHistoryRecord & { readonly reason: string | null })[]> {
    const customerId = await this.viewable(scope, actor, id);
    await this.deps.guard.check(scope, actor, AUDIT_VIEW);
    return this.deps.auditHistory.customerTimeline(scope, customerId, CUSTOMER_TIMELINE_LIMIT);
  }

  private async viewable(scope: TenantContext, actor: ActorContext, id: string): Promise<UserId> {
    await this.deps.guard.check(scope, actor, CUSTOMER_VIEW_PERMISSION);
    const parsed = userIdSchema.safeParse(id);
    if (!parsed.success) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That is not a valid customer identifier.',
      );
    }
    if ((await this.deps.customers.findById(scope, parsed.data)) === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
    }
    return parsed.data;
  }
}

function sumCount(rows: readonly { readonly count: number }[]): number {
  return rows.reduce((sum, row) => sum + row.count, 0);
}

/** Summed per currency, never across: two currencies are never one figure. */
function perCurrency<T extends { readonly currency: string; readonly count: number }>(
  rows: readonly T[],
  amountOf: (row: T) => bigint,
): PerCurrency[] {
  const byCurrency = new Map<string, { count: number; amount: bigint }>();
  for (const row of rows) {
    const held = byCurrency.get(row.currency) ?? { count: 0, amount: 0n };
    byCurrency.set(row.currency, {
      count: held.count + row.count,
      amount: held.amount + amountOf(row),
    });
  }
  return [...byCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, total]) => ({ currency, count: total.count, amount: total.amount }));
}
