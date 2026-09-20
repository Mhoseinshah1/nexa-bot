import type { ServiceUsernameMode, TenantContext } from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';

/**
 * One order's claim on one name, in one provider account namespace.
 *
 * `namespaceKey` is derived — `<provider_type>:<host>[:<port>]` — and deliberately not
 * `panelId`. Two panels of one tenant, or of two tenants, that point at the same
 * provider host share its account namespace whether or not either knows about the
 * other, and a name one of them creates is a name the other cannot have. Keying on the
 * panel would let the second discover that from the provider, after the money moved.
 */
export interface UsernameReservation {
  readonly id: string;
  readonly namespaceKey: string;
  readonly username: string;
  readonly panelId: string;
  readonly orderId: string;
  readonly customerId: string;
  readonly mode: ServiceUsernameMode;
  /** When the money for this name committed, or null while the checkout is unfunded. */
  readonly fundedAt: Date | null;
  readonly expiresAt: Date;
}

export interface ReserveUsernameInput {
  readonly id: string;
  readonly namespaceKey: string;
  readonly username: string;
  readonly panelId: string;
  readonly orderId: string;
  readonly customerId: string;
  readonly mode: ServiceUsernameMode;
  readonly expiresAt: Date;
}

/**
 * Why a reservation attempt did not produce a row, and the two reasons are different
 * answers to the customer.
 *
 * `NAME_TAKEN` is somebody else holding this name: for CUSTOM the customer is told and
 * types another, for RANDOM the caller draws again. `ORDER_ALREADY_HELD` is this order
 * already holding a name — a replayed callback, a double tap, a second replica — and
 * the held name is returned rather than a second one being taken.
 */
export type ReserveUsernameOutcome =
  | { readonly outcome: 'RESERVED'; readonly reservation: UsernameReservation }
  | { readonly outcome: 'NAME_TAKEN' }
  | { readonly outcome: 'ORDER_ALREADY_HELD'; readonly reservation: UsernameReservation };

export interface ServiceUsernameRepository {
  /** This order's held name, or null. The idempotency read, and what provisioning uses. */
  findByOrder(
    scope: TenantContext,
    orderId: string,
    tx: TransactionScope,
  ): Promise<UsernameReservation | null>;

  /**
   * Take the name, or say which conflict stopped it.
   *
   * A conditional INSERT, never a read-then-write. The two unique indexes ARE the
   * decision: `(namespace_key, username)` refuses a name somebody else holds and
   * `(tenant_id, order_id)` refuses a second name for one order. A check issued before
   * the insert sees the state the loser started from.
   */
  reserve(
    scope: TenantContext,
    input: ReserveUsernameInput,
    tx: TransactionScope,
  ): Promise<ReserveUsernameOutcome>;

  /**
   * Is this name already the name of a live service on this panel?
   *
   * Asked in addition to the reservation index, because services created before this
   * phase carry names no reservation row was ever written for. Without it a template
   * could render a name a legacy service already has, pass the reservation index, and
   * fail at `services_panel_provider_username_key` — after the money moved.
   */
  usernameInUseOnPanel(
    scope: TenantContext,
    panelId: string,
    username: string,
    tx: TransactionScope,
  ): Promise<boolean>;

  /**
   * Stamp the name as paid for. Idempotent, and it never moves `funded_at` backwards.
   *
   * After this the row is held for ever as far as the reaper is concerned:
   * `expires_at` alone is not release. A funded name past its expiry belongs to a
   * service the customer is holding.
   */
  markFunded(
    scope: TenantContext,
    orderId: string,
    at: Date,
    tx: TransactionScope,
  ): Promise<boolean>;

  /**
   * Give the name back. Only on a terminal non-delivery, and only for THIS order.
   *
   * Returns whether a row was removed, so a caller can tell "released it" from
   * "there was nothing to release" — which is a normal outcome on a legacy-mode panel,
   * where no reservation is taken at all.
   */
  release(scope: TenantContext, orderId: string, tx: TransactionScope): Promise<boolean>;
}
