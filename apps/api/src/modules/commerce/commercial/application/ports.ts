import type {
  Money,
  OrderId,
  OrderPurpose,
  ProductId,
  ServiceAddonId,
  ServiceLocationId,
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
  readonly kind: Exclude<OrderPurpose, 'NEW_SERVICE' | 'TRIAL' | 'CUSTOM_SERVICE'>;
  /** A renewal names the product it was quoted from; a quantity purchase the add-on. */
  readonly productId: ProductId | null;
  readonly addonId: ServiceAddonId | null;
  /** What was bought. Zero in the field this kind did not buy. */
  readonly purchasedTrafficBytes: bigint;
  readonly purchasedDurationDays: number;
  /** WP-A5: extra users / devices bought. Positive for `ADD_DEVICES`, zero otherwise. */
  readonly purchasedDeviceCount: number;
  /** WP-A5: the add-on version an `ADD_DEVICES` purchase was priced from; null otherwise. */
  readonly addonVersion: number | null;
  /** WP-A6: the configured location a `CHANGE_LOCATION` was priced from; null otherwise. */
  readonly locationId: ServiceLocationId | null;
  /** What was paid, with its currency. Never an amount without one. */
  readonly amount: Money;
  readonly createdAt: Date;
}

export interface CommercialActionDraft {
  readonly id: string;
  readonly customerId: UserId;
  readonly serviceId: string;
  readonly orderId: OrderId;
  readonly kind: Exclude<OrderPurpose, 'NEW_SERVICE' | 'TRIAL' | 'CUSTOM_SERVICE'>;
  readonly productId: ProductId | null;
  readonly addonId: ServiceAddonId | null;
  readonly purchasedTrafficBytes: bigint;
  readonly purchasedDurationDays: number;
  readonly purchasedDeviceCount: number;
  readonly addonVersion: number | null;
  /** WP-A6, `CHANGE_LOCATION` only. */
  readonly locationId: ServiceLocationId | null;
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

  /**
   * How many extra users / devices this service has been sold and not given back
   * (WP-A5): the sum over its `ADD_DEVICES` actions whose ORDER is live — awaiting
   * payment or paid — or whose raise was DELIVERED (its `ADD_DEVICES` operation
   * succeeded, or may have), refunded or not, asked of the rows at read time. There is no counter, for the reason
   * discount limits have none: a counter nothing re-derives is a second answer to "how
   * many". `excludeOrderId` leaves out the order being decided, so it is not counted
   * against itself.
   */
  soldDeviceQuantity(
    scope: TenantContext,
    serviceId: string,
    excludeOrderId: OrderId | null,
    tx?: unknown,
  ): Promise<number>;

  /**
   * How many extra users / devices this service has been sold and NOT YET GIVEN (WP-A8,
   * Codex #2 on PR #102): its `ADD_DEVICES` actions whose order is live — awaiting
   * payment or paid — and whose raise has not succeeded. `services.device_limit` moves
   * only when a raise succeeds, so an absolute ceiling judged against the recorded limit
   * alone let two live purchases each fit and together pass it; settlement computes each
   * target from the limit recorded THEN plus what was bought. `UNKNOWN` counts: that
   * write may have landed and the recorded limit has not moved yet.
   */
  unappliedDeviceQuantity(
    scope: TenantContext,
    serviceId: string,
    excludeOrderId: OrderId | null,
    tx?: unknown,
  ): Promise<number>;

  /** This service's actions, newest first, for a detail view and an operator's history. */
  listForService(
    scope: TenantContext,
    serviceId: string,
    limit: number,
    tx?: unknown,
  ): Promise<readonly CommercialActionRecord[]>;
}
