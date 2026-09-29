import type {
  LocationChangeLimits,
  Money,
  OrderId,
  PanelId,
  ProductId,
  ServiceLocationId,
  TenantContext,
  UserId,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';

/**
 * Service location change (WP-A6) — the persistence the module needs, and nothing else.
 *
 * Two tables. `service_locations` is the operator's configuration: a panel's named
 * locations, which one new accounts start in, and which may be moved TO at what price.
 * `service_location_changes` is the customer's side: one frozen row per requested change,
 * the snapshot every later decision and the history read.
 */

/** One configured location of one panel. */
export interface ServiceLocationRecord {
  readonly id: ServiceLocationId;
  readonly tenantId: string;
  readonly panelId: PanelId;
  /** Null is every product on the panel. */
  readonly productId: ProductId | null;
  /** Adapter-defined; never shown to a customer and never parsed by Nexa. */
  readonly locationKey: string;
  readonly label: string;
  readonly initial: boolean;
  readonly enabled: boolean;
  /** Null is "not for sale", never free. A zero amount is free. */
  readonly price: Money | null;
  readonly limits: LocationChangeLimits;
  readonly sortOrder: number;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What an operator writes. The version is the repository's, bumped on every edit. */
export interface ServiceLocationDraft {
  readonly panelId: PanelId;
  readonly productId: ProductId | null;
  readonly locationKey: string;
  readonly label: string;
  readonly initial: boolean;
  readonly enabled: boolean;
  readonly price: Money | null;
  readonly limits: LocationChangeLimits;
  readonly sortOrder: number;
}

/** Which unique rule a write collided with, so the refusal can name it. */
export type ServiceLocationConflict = 'DUPLICATE_KEY' | 'SECOND_INITIAL';

export interface ServiceLocationRepository {
  /** The tenant's locations, by panel, then the operator's order. Bounded by the caller. */
  list(
    scope: TenantContext,
    limit: number,
    tx?: unknown,
  ): Promise<readonly ServiceLocationRecord[]>;

  findById(
    scope: TenantContext,
    id: ServiceLocationId,
    tx?: unknown,
  ): Promise<ServiceLocationRecord | null>;

  /** Every location of one panel — the policy's whole input for a service on it. */
  forPanel(
    scope: TenantContext,
    panelId: string,
    tx?: unknown,
  ): Promise<readonly ServiceLocationRecord[]>;

  create(
    scope: TenantContext,
    input: {
      readonly id: ServiceLocationId;
      readonly draft: ServiceLocationDraft;
      readonly now: Date;
    },
    tx: TransactionScope,
  ): Promise<
    | { readonly ok: true; readonly record: ServiceLocationRecord }
    | { readonly ok: false; readonly conflict: ServiceLocationConflict }
  >;

  /** The edit, with `version + 1`. Null when the row is gone. */
  update(
    scope: TenantContext,
    id: ServiceLocationId,
    draft: ServiceLocationDraft,
    now: Date,
    tx: TransactionScope,
  ): Promise<
    | { readonly ok: true; readonly record: ServiceLocationRecord | null }
    | { readonly ok: false; readonly conflict: ServiceLocationConflict }
  >;

  delete(scope: TenantContext, id: ServiceLocationId, tx: TransactionScope): Promise<boolean>;

  /**
   * Serialises every write to this tenant's locations (Codex review #1 on PR #101): taken
   * FIRST in each write's transaction, so the per-tenant and per-panel counts a create
   * checks cannot both be read by two concurrent creates.
   */
  lockForWrite(scope: TenantContext, tx: TransactionScope): Promise<void>;

  /** Whether any change request or commercial action names this location. */
  isReferenced(scope: TenantContext, id: ServiceLocationId, tx: TransactionScope): Promise<boolean>;
}

/** One requested change, frozen at request time. */
export interface LocationChangeRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly serviceId: string;
  readonly customerId: UserId;
  readonly locationId: ServiceLocationId;
  readonly locationVersion: number;
  readonly fromLocationKey: string;
  readonly fromLocationLabel: string;
  readonly toLocationKey: string;
  readonly toLocationLabel: string;
  /** The configured list price at quote time; zero is free. The charged total is the order's. */
  readonly price: Money;
  /** The cooldown and limit it was quoted under — what a paid move's confirmation honours. */
  readonly limits: LocationChangeLimits;
  /** A paid change's order; null for a free one. */
  readonly orderId: OrderId | null;
  /** A free change's operation row id; null for a paid one (its operation names the order). */
  readonly operationId: string | null;
  readonly createdAt: Date;
}

export interface LocationChangeDraft {
  readonly id: string;
  readonly serviceId: string;
  readonly customerId: UserId;
  readonly locationId: ServiceLocationId;
  readonly locationVersion: number;
  readonly fromLocationKey: string;
  readonly fromLocationLabel: string;
  readonly toLocationKey: string;
  readonly toLocationLabel: string;
  readonly price: Money;
  readonly limits: LocationChangeLimits;
  readonly orderId: OrderId | null;
  readonly operationId: string | null;
  readonly now: Date;
}

export interface LocationChangeRepository {
  create(
    scope: TenantContext,
    draft: LocationChangeDraft,
    tx: TransactionScope,
  ): Promise<LocationChangeRecord>;

  findByOrderId(
    scope: TenantContext,
    orderId: OrderId,
    tx?: unknown,
  ): Promise<LocationChangeRecord | null>;

  /**
   * The change an operation carries out: a free one by its operation, a paid one by the
   * order the operation names. Null for an operation no change request stands behind.
   */
  findForOperation(
    scope: TenantContext,
    operation: { readonly id: string; readonly orderId: OrderId | null },
    tx?: unknown,
  ): Promise<LocationChangeRecord | null>;

  /**
   * When each of this service's changes that still COUNT was requested, for the cooldown
   * and the rolling limit (`locationChangeWindow`). Asked of the rows at decision time,
   * never kept in a counter:
   *
   * - a paid change counts while its order awaits payment or is paid, AND after a refund
   *   when its operation SUCCEEDED or is UNKNOWN — a refund does not move the account
   *   back, so a delivered move keeps its place (the lesson of WP-A5's cap);
   * - a free change counts unless its operation FAILED or was ABANDONED.
   *
   * A draft that never became an order awaiting payment, a cancelled or expired order and
   * a move that provably did not happen do not count. `excludeOrderId` leaves out the
   * order being decided.
   */
  countedRequestTimes(
    scope: TenantContext,
    serviceId: string,
    excludeOrderId: OrderId | null,
    tx?: unknown,
  ): Promise<readonly Date[]>;

  /** This service's changes, newest first, bounded. */
  listForService(
    scope: TenantContext,
    serviceId: string,
    limit: number,
    tx?: unknown,
  ): Promise<readonly LocationChangeRecord[]>;
}
