import type {
  ServiceUsernameMode,
  TenantContext,
  UsernameCaptureCloseReason,
} from '@nexa/contracts';
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
    tx?: TransactionScope,
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
   * Unconditional, funded or not, and that is exactly what separates it from
   * `releaseUnfunded`. Its one caller is the undeliverable-order refunder, which runs
   * only where the create is DEFINITIVELY known not to have happened. An `UNKNOWN`
   * outcome never reaches it — the money rules send that to `UNRECONCILED` instead —
   * because a create whose answer was lost may be holding the name on a panel, and
   * selling it to somebody else would promise an account this installation cannot make.
   *
   * Returns whether a row was removed, so a caller can tell "released it" from
   * "there was nothing to release" — which is a normal outcome on a legacy-mode panel,
   * where no reservation is taken at all.
   */
  release(scope: TenantContext, orderId: string, tx: TransactionScope): Promise<boolean>;

  /**
   * Give back a name no money has been taken for.
   *
   * The cancellation, expiry and re-selection path, and the `funded_at IS NULL` in it
   * is the entire guard. A funded hold names an account that may already exist, so a
   * cancellation arriving after settlement — a second tap, a redelivered callback, a
   * sweep racing a payment — must find nothing to free. Only `release` above may take
   * a funded name back, and only on the one fact that proves no account exists.
   */
  releaseUnfunded(scope: TenantContext, orderId: string, tx: TransactionScope): Promise<boolean>;

  /**
   * Remove holds that no order will ever fund, oldest deadline first.
   *
   * `expires_at` stops a hold being HONOURED; it does not remove the row, and the row
   * is what `service_username_reservations_name_key` reads. Without this sweep a draft
   * the customer abandoned takes its name out of circulation for good — and on a panel
   * whose customers choose their own names, "for good" is the name they wanted. The
   * cancellation and expiry paths cover the orders that END; this covers the drafts
   * that simply stop.
   *
   * Bounded, and `funded_at IS NULL` again: a funded hold past its deadline belongs to
   * an order that took money, and a deadline says nothing about the account on a panel.
   * Returns how many rows went.
   *
   * Never a hold whose order is still `AWAITING_PAYMENT` (Payment File 02 §9, D1): a
   * receipted transfer keeps its order open past every deadline, and the order-expiry
   * path releases the hold when the order actually closes.
   */
  sweepExpiredHolds(
    scope: TenantContext,
    now: Date,
    limit: number,
    tx: TransactionScope,
  ): Promise<number>;
}

/**
 * A window in which an ordinary message from this customer means "this is my username".
 *
 * See `username_captures`. The narrow point of the whole mechanism is that a window
 * names ONE order: whatever a redelivered or unexpected message contains, the only
 * thing an open window can do with it is offer it to the allocator for that order.
 */
export interface UsernameCaptureRecord {
  readonly id: string;
  readonly botInstanceId: string;
  readonly customerId: string;
  readonly orderId: string;
  readonly openedAt: Date;
  readonly expiresAt: Date;
}

export interface UsernameCaptureRepository {
  /**
   * Serialise this customer's window work on this bot.
   *
   * An advisory lock rather than a row lock, because the row a caller wants to lock is
   * the one it is about to decide whether to create. Two taps arriving together both
   * read "nothing open" without it, and `username_captures_open_key` then turns the
   * loser into a 23505 rather than a queue.
   */
  lockForCustomer(
    scope: TenantContext,
    botInstanceId: string,
    customerId: string,
    tx: TransactionScope,
  ): Promise<void>;

  /**
   * Close whatever was open and open a new one, in the caller's transaction.
   *
   * One transaction and not two: the partial unique index refuses a second open row, so
   * a split would leave the customer with no window between the close and the open —
   * and the tap that asked for one has already been answered.
   */
  open(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly botInstanceId: string;
      readonly customerId: string;
      readonly orderId: string;
      readonly openedAt: Date;
      readonly expiresAt: Date;
    },
    tx: TransactionScope,
  ): Promise<UsernameCaptureRecord>;

  findOpen(
    scope: TenantContext,
    botInstanceId: string,
    customerId: string,
    tx: TransactionScope,
  ): Promise<UsernameCaptureRecord | null>;

  /**
   * Close one window, naming why. Conditional on it still being open.
   *
   * `RECEIVED` is stamped only for a name that was ACCEPTED. A refused one leaves the
   * window open on purpose: the customer is being asked to type another, and closing it
   * would strand them mid-question with a button they have already used.
   */
  close(
    scope: TenantContext,
    id: string,
    reason: UsernameCaptureCloseReason,
    at: Date,
    tx: TransactionScope,
  ): Promise<boolean>;
}
