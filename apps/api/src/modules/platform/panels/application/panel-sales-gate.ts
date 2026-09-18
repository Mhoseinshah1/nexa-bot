import { PANEL_RESERVATION_TTL_MS, type TenantContext } from '@nexa/contracts';
import type { Clock, IdGenerator } from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { PanelCapacityRepository } from './capacity-ports.js';
import { decideEligibility, type PanelEligibility } from './panel-eligibility.js';
import type { PanelRepository } from './ports.js';

export interface PanelSalesGateDeps {
  readonly panels: PanelRepository;
  readonly capacity: PanelCapacityRepository;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

/**
 * THE evaluator for "may this panel take new business", and the one holder of a
 * capacity slot.
 *
 * One object rather than a rule each caller applies, because there are four
 * callers and they are in three modules: the catalogue decides what to SHOW,
 * order confirmation decides what to SELL and takes the slot, settlement
 * re-decides and consumes it, and the release lanes give it back. A predicate
 * copied into four places is a predicate that will disagree with itself, and the
 * disagreement is invisible: the catalogue would go on offering something
 * confirmation refuses, or — far worse — confirmation would accept something
 * settlement then refuses, after the money has moved.
 *
 * ## Catalogue filtering is a courtesy; these two are the rule
 *
 * `visible` is a UX filter and nothing hangs on it. A product id travels in a
 * screenshot, a callback drawn a minute ago is still in the chat, and a
 * catalogue read is a snapshot. So `acquire` re-decides inside the confirming
 * transaction under the panel's lock, and `consume` re-decides again inside the
 * settling one. Neither trusts that the caller got here by a route the
 * catalogue approved.
 */
export class PanelSalesGate {
  constructor(private readonly deps: PanelSalesGateDeps) {}

  /**
   * Whether this panel may be sold onto, as of now. A READ: locks nothing,
   * writes nothing, and is safe to call outside a transaction.
   *
   * What the catalogue and the Web Admin use. Its answer is advisory by
   * construction — see the class docblock.
   */
  async evaluate(
    scope: TenantContext,
    panelId: string,
    tx?: TransactionScope,
  ): Promise<PanelEligibility> {
    const found = await this.evaluateMany(scope, [panelId], tx);
    /*
     * A panel this tenant does not have reads as ARCHIVED rather than as an
     * error, because every caller of this method is deciding whether to OFFER
     * something and the answer is the same: no. Naming it `ARCHIVED` keeps the
     * reason vocabulary closed; the refusal that a surface renders never carries
     * it anyway.
     */
    return found.get(panelId) ?? { eligible: false, reason: 'ARCHIVED' };
  }

  /**
   * The same for many panels, in two queries rather than two per panel.
   *
   * A panel the tenant does not have is simply absent from the map. The caller
   * decides what that means — for the catalogue it is a product bound to a panel
   * that is gone, which is not sellable either.
   */
  async evaluateMany(
    scope: TenantContext,
    panelIds: readonly string[],
    tx?: TransactionScope,
  ): Promise<ReadonlyMap<string, PanelEligibility>> {
    const verdicts = new Map<string, PanelEligibility>();
    const unique = [...new Set(panelIds)];
    if (unique.length === 0) return verdicts;

    const now = this.deps.clock.now();
    // TWO reads for the whole page, never one per panel. The catalogue asks this
    // about every product it is about to show, and a `find` per product is a
    // round trip per row.
    const capacities = await this.deps.capacity.readMany(scope, unique, now, tx);
    const views = await this.deps.panels.findMany(scope, unique, tx);
    for (const view of views) {
      const capacity = capacities.get(view.panel.id);
      verdicts.set(
        view.panel.id,
        decideEligibility({
          status: view.panel.status,
          health: view.health,
          maxServices: capacity?.maxServices ?? view.panel.maxServices,
          used: capacity?.used ?? 0,
          now,
        }),
      );
    }
    return verdicts;
  }

  /**
   * Re-decide and TAKE the slot for this order, inside the caller's transaction.
   *
   * Eligible means the order now holds exactly one reservation on this panel and
   * may be charged for. Ineligible means nothing was taken and the caller must
   * refuse before any money moves.
   *
   * The order is deliberate: status and health are decided from the row read
   * under the panel's lock, and capacity is decided by `reserve`, which takes
   * the same lock and counts afterwards. So every reason is evaluated against a
   * state no concurrent confirmation can be halfway through changing.
   *
   * A replayed confirmation finds its own hold and is answered ELIGIBLE. That is
   * not a special case bolted on: an order that already holds its slot is not
   * asking for another, and refusing a retry that already succeeded is how a
   * customer is blocked at a step they had passed.
   */
  async acquire(
    scope: TenantContext,
    panelId: string,
    orderId: string,
    tx: TransactionScope,
    /**
     * When this hold stops counting — the ORDER's own deadline, never a number
     * invented here.
     *
     * A hold that outlives the order it is held for is a slot nobody can use and
     * nothing will free; one that expires first lets a customer who is still
     * inside their stated window lose the thing they were promised. Falls back to
     * `PANEL_RESERVATION_TTL_MS` only for an order with no deadline at all.
     */
    expiresAt: Date | null,
  ): Promise<PanelEligibility> {
    const now = this.deps.clock.now();
    if (!(await this.deps.panels.lockPanel(scope, panelId, tx))) {
      return { eligible: false, reason: 'ARCHIVED' };
    }
    const view = await this.deps.panels.find(scope, panelId, tx);
    // Gone between the lock and the read is not reachable — the lock holds the
    // row — but a panel of another tenant reads as absent, and that is refused
    // rather than treated as fine.
    if (view === null) return { eligible: false, reason: 'ARCHIVED' };

    /*
     * The non-capacity reasons first, and WITHOUT the capacity numbers.
     *
     * `decideEligibility` checks status and health before capacity, so passing
     * a cap of null here cannot change which reason comes back for an archived,
     * disabled or confirmed-down panel — and it stops this path issuing a count
     * whose answer the reserve below is about to compute again under the lock.
     */
    const before = decideEligibility({
      status: view.panel.status,
      health: view.health,
      maxServices: null,
      used: 0,
      now,
    });
    if (!before.eligible) return before;

    const taken = await this.deps.capacity.reserve(
      scope,
      {
        id: this.deps.ids.uuid(),
        panelId,
        orderId,
        expiresAt: expiresAt ?? new Date(now.getTime() + PANEL_RESERVATION_TTL_MS),
      },
      now,
      tx,
    );
    switch (taken.outcome) {
      case 'RESERVED':
      case 'ALREADY_HELD':
        return { eligible: true };
      case 'AT_CAPACITY':
        return { eligible: false, reason: 'AT_CAPACITY' };
      case 'PANEL_GONE':
        return { eligible: false, reason: 'ARCHIVED' };
    }
  }

  /**
   * Hand the slot from the reservation to the service that is about to be
   * written, and re-decide one last time.
   *
   * Called inside the SETTLING transaction, before the service row exists. The
   * release comes first on purpose: the order's own hold must not be counted
   * against the order's own service, or the last slot on a panel would refuse
   * the settlement it was reserved for. Nothing else can observe the gap,
   * because the panel's lock is held across it and the service is written before
   * the transaction commits.
   *
   * `alreadyProvisioned` is the replay, and it skips the decision entirely. A
   * settlement replayed after the panel filled up or was disabled must not be
   * refused: it changes nothing, the customer already has their service, and
   * refusing would roll back a transaction whose money has already moved.
   */
  async consume(
    scope: TenantContext,
    panelId: string,
    orderId: string,
    tx: TransactionScope,
    alreadyProvisioned: boolean,
  ): Promise<PanelEligibility> {
    const now = this.deps.clock.now();
    if (!(await this.deps.panels.lockPanel(scope, panelId, tx))) {
      return alreadyProvisioned ? { eligible: true } : { eligible: false, reason: 'ARCHIVED' };
    }
    await this.deps.capacity.release(scope, orderId, tx);
    if (alreadyProvisioned) return { eligible: true };

    const view = await this.deps.panels.find(scope, panelId, tx);
    if (view === null) return { eligible: false, reason: 'ARCHIVED' };
    const capacity = await this.deps.capacity.read(scope, panelId, now, tx);
    return decideEligibility({
      status: view.panel.status,
      health: view.health,
      maxServices: capacity?.maxServices ?? view.panel.maxServices,
      used: capacity?.used ?? 0,
      now,
    });
  }

  /**
   * Give the slot back. True when a hold actually existed.
   *
   * One method for cancellation and for the expiry sweep, because they are the
   * same act. Idempotent, so a lane that runs twice is not an error.
   */
  async release(scope: TenantContext, orderId: string, tx: TransactionScope): Promise<boolean> {
    return this.deps.capacity.release(scope, orderId, tx);
  }
}
