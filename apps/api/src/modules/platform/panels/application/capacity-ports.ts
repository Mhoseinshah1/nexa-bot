import type { PanelIneligibilityReason, TenantContext } from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { PanelView } from './ports.js';

/**
 * What a panel's capacity looks like right now.
 *
 * Three numbers and a cap, and the three are kept apart on purpose. An operator
 * looking at a full panel needs to know whether it is full of SERVICES — which
 * they can only fix by raising the cap or terminating something — or full of
 * HOLDS, which resolve themselves within the reservation lifetime. One `used`
 * number cannot answer that, and "the panel is full" with no way to tell which
 * is the shape of every capacity complaint the legacy system produced.
 *
 * `used` is nevertheless the sum, computed in the same query, because a caller
 * that adds two numbers it fetched separately has a third opinion about what
 * capacity means.
 */
export interface PanelCapacity {
  /** Services on this panel in a state that occupies a slot. */
  readonly services: number;
  /** Holds taken for an order and not yet expired or released. */
  readonly reservations: number;
  /** `services + reservations`. What the cap is compared against. */
  readonly used: number;
  /** The operator's cap, or null for no limit. */
  readonly maxServices: number | null;
  /** `maxServices - used`, floored at zero, or null when there is no cap. */
  readonly available: number | null;
}

/**
 * What happened when a slot was asked for.
 *
 * `ALREADY_HELD` is a SUCCESS and the caller must treat it as one: it is the
 * answer to a confirmation replayed by a retry, a double-tapped button or a
 * second replica, and the order already holds exactly the one slot it is owed.
 * Answering it as a refusal would make a retry able to fail an order that had
 * already succeeded, which is the whole failure mode the unique index exists to
 * prevent.
 *
 * `PANEL_GONE` is separate from `AT_CAPACITY` because they send an operator to
 * different places. A panel deleted out from under a draft order is a
 * configuration problem; a full one is a business condition.
 */
export type CapacityAcquisition =
  | { readonly outcome: 'RESERVED' }
  | { readonly outcome: 'ALREADY_HELD' }
  | { readonly outcome: 'AT_CAPACITY'; readonly capacity: PanelCapacity }
  | { readonly outcome: 'PANEL_GONE' };

export interface ReserveCapacityInput {
  readonly id: string;
  readonly panelId: string;
  readonly orderId: string;
  /** When this hold stops counting whatever else has happened. */
  readonly expiresAt: Date;
}

/**
 * Slots on a panel: counting them, taking one, giving it back.
 *
 * A port of its own rather than four more methods on `PanelRepository`, because
 * its consumers are somewhere else entirely — the order path, the settlement
 * path and the two release lanes, none of which have any other business with
 * panels. A capacity method on the panel repository would arrive in every
 * surface that lists panels, and `read` on `PanelCredentialStore` is the
 * precedent: the port boundary is what keeps a capability out of scope where it
 * is not needed.
 *
 * Everything here is tenant-scoped and nothing resolves a panel or an order by
 * id alone.
 */
export interface PanelCapacityRepository {
  /**
   * The panel's capacity as of `now`, or null when the tenant has no such panel.
   *
   * ONE query. The services count, the reservation count and the cap come back
   * together because a caller that issued three would be comparing numbers from
   * three different instants, and the instant capacity is asked about is the
   * only one at which the comparison means anything.
   */
  read(
    scope: TenantContext,
    panelId: string,
    now: Date,
    tx?: TransactionScope,
  ): Promise<PanelCapacity | null>;

  /**
   * The same, for many panels at once.
   *
   * Exists so a list of panels costs one query rather than one per row. Panels
   * the tenant does not have are simply absent from the map.
   */
  readMany(
    scope: TenantContext,
    panelIds: readonly string[],
    now: Date,
    tx?: TransactionScope,
  ): Promise<ReadonlyMap<string, PanelCapacity>>;

  /**
   * The same, for every panel this tenant has, without being told their ids.
   *
   * Exists so the catalogue can decide WHICH panels are sellable before it asks
   * for products, rather than asking for products and discarding the ones whose
   * panel turned out not to be — which is what put a correctness ceiling on the
   * catalogue and hid an eligible product behind a screenful of ineligible ones.
   *
   * Unbounded, and deliberately the only unbounded read on that path. A tenant's
   * panels are infrastructure an operator provisions by hand, not catalogue rows:
   * the set is the fleet, it is one indexed statement, and every PRODUCT query
   * downstream stays bounded by the caller's own limit. Bounding this instead
   * would move the ceiling rather than remove it.
   */
  readAll(
    scope: TenantContext,
    now: Date,
    tx?: TransactionScope,
  ): Promise<ReadonlyMap<string, PanelCapacity>>;

  /**
   * Take one slot for this order, or report why not.
   *
   * MUST run inside a transaction, and takes the panel's row lock as its first
   * statement. That lock is the whole mechanism: under READ COMMITTED the count
   * that follows takes a fresh snapshot AFTER the lock is granted, so a
   * reservation committed by the transaction this one waited for is visible to
   * it. A count taken before the lock — or a single `INSERT ... SELECT` whose
   * subqueries are planned against the pre-wait snapshot — sees the state the
   * loser started from, and both callers are sold the last slot.
   *
   * The lock is the SAME one every panel mutation takes (`lockPanel`), which is
   * what makes lowering the cap and taking the last slot serialise against each
   * other rather than racing, and why there is no order in which to deadlock.
   */
  reserve(
    scope: TenantContext,
    input: ReserveCapacityInput,
    now: Date,
    tx: TransactionScope,
  ): Promise<CapacityAcquisition>;

  /**
   * Give back the slot this order holds. True when a row was actually deleted.
   *
   * One method for every release: the payment expiring, being rejected, the
   * order cancelled, and the settlement that hands the slot to a service. They
   * are one operation because they do one thing, and a per-reason method would
   * be four places to forget the `tenant_id` predicate. WHY it was released is
   * in the audit trail and the order's own history.
   *
   * Idempotent: a second release of an order that holds nothing returns false
   * and is not an error. A release that runs twice is the normal shape of a
   * retried lane.
   */
  release(scope: TenantContext, orderId: string, tx: TransactionScope): Promise<boolean>;
}

/**
 * Why a panel may not be sold onto, as the caller that refused says it.
 *
 * Carried out of the application layer so a refusal can be logged and audited
 * with the reason a human can act on, and so the two re-checks — at
 * confirmation and at settlement — cannot report different vocabularies for the
 * same condition.
 */
export interface PanelIneligible {
  readonly panelId: string;
  readonly reason: PanelIneligibilityReason;
}

/**
 * A panel view with its occupancy attached.
 *
 * Composed by `PanelService` from two repositories rather than returned by one,
 * because capacity counts `services` — a table the panels module does not own
 * and must not learn to join. It EXTENDS `PanelView` so every existing reader of
 * one keeps working and only the readers that want capacity have to know it is
 * there.
 */
export interface PanelWithCapacity extends PanelView {
  readonly capacity: PanelCapacity;
}
