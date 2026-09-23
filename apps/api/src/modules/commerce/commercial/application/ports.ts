import type {
  Money,
  OrderId,
  OrderPurpose,
  ProductId,
  ServiceAddonId,
  TenantContext,
  UserId,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';

/**
 * One commercial action, as the application layer sees it.
 *
 * The INVOICE LINE for a renewal or a quantity purchase, written when the order is
 * created and never afterwards. That placement is the legacy system's own — `TBR-009`
 * records that its extra-volume invoice exists at quantity entry, before a payment
 * method is chosen — and it is what lets settlement find the service an order acts on
 * without `orders` carrying a pointer it cannot carry safely.
 *
 * It is not evidence that anything HAPPENED. The order's state says whether it was paid
 * and the operation says whether the panel applied it; this row says what was bought,
 * from where, for how much.
 */
export interface CommercialActionRecord {
  readonly id: string;
  readonly customerId: UserId;
  readonly serviceId: string;
  readonly orderId: OrderId;
  readonly kind: Exclude<OrderPurpose, 'NEW_SERVICE' | 'TRIAL'>;
  /** A renewal names the product it was quoted from; a quantity purchase the add-on. */
  readonly productId: ProductId | null;
  readonly addonId: ServiceAddonId | null;
  /** What was bought. Zero in the field this kind did not buy. */
  readonly purchasedTrafficBytes: bigint;
  readonly purchasedDurationDays: number;
  /** What was paid, with its currency. Never an amount without one. */
  readonly amount: Money;
  readonly createdAt: Date;
}

export interface CommercialActionDraft {
  readonly id: string;
  readonly customerId: UserId;
  readonly serviceId: string;
  readonly orderId: OrderId;
  readonly kind: Exclude<OrderPurpose, 'NEW_SERVICE' | 'TRIAL'>;
  readonly productId: ProductId | null;
  readonly addonId: ServiceAddonId | null;
  readonly purchasedTrafficBytes: bigint;
  readonly purchasedDurationDays: number;
  readonly amount: Money;
  readonly now: Date;
}

export interface CommercialActionRepository {
  /**
   * Writes the invoice line, in the same transaction as the order it belongs to.
   *
   * It may LOSE — `service_commercial_actions_order_key` is unique on
   * `(tenant_id, order_id)` — and losing is a normal outcome of a replayed command or a
   * second replica, so it is reported as `null` rather than thrown. The caller reads the
   * winner's row, exactly as `ServiceRepository.create` has it.
   */
  create(
    scope: TenantContext,
    draft: CommercialActionDraft,
    tx: TransactionScope,
  ): Promise<CommercialActionRecord | null>;

  /** The one action an order carries, if it is a commercial order at all. */
  findByOrderId(
    scope: TenantContext,
    orderId: OrderId,
    tx?: unknown,
  ): Promise<CommercialActionRecord | null>;

  /** This service's actions, newest first, for a detail view and an operator's history. */
  listForService(
    scope: TenantContext,
    serviceId: string,
    limit: number,
    tx?: unknown,
  ): Promise<readonly CommercialActionRecord[]>;
}
