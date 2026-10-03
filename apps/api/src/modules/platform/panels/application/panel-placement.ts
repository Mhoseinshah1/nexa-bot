import type {
  Clock,
  PanelBalancingStrategy,
  PanelIneligibilityReason,
  PanelPlacementDecider,
  PanelPlacementExclusion,
  TenantContext,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { PanelCapacity } from './capacity-ports.js';
import type { PanelEligibility } from './panel-eligibility.js';
import { readHealth } from './panel-health-view.js';
import type { PanelSalesGate } from './panel-sales-gate.js';
import type { PanelRepository, PanelView } from './ports.js';

/**
 * Automatic panel balancing (Phase C3). `docs/panel-balancing.md` is the long form.
 *
 * WHERE a new account goes, decided once, when the order's DRAFT is written — not at
 * confirmation. The draft is what the customer is shown: its line, its price, and the
 * username step that follows reserves a name in the chosen panel's own namespace and
 * shows it in the summary they confirm. Moving the order to another panel at confirmation
 * would put them on a machine whose namespace their name was never checked against, or
 * hand them a name they were never shown. So the choice is made before the username step,
 * and confirmation keeps doing exactly what it does: `PanelSalesGate.acquire` re-decides
 * eligibility under the panel's lock and takes the slot or refuses. There is no second
 * capacity claim, no second lock and no change to the lock order (order → panel →
 * reservation); a placement is a READ that chooses which panel that one claim is for.
 *
 * What it is NOT:
 *   - a second eligibility rule. Only panels `decideEligibility` calls eligible — through
 *     `PanelSalesGate.assessMany`, the same reads and verdicts as the catalogue's — are
 *     ranked. Drained, disabled, confirmed-unhealthy, full or unvalidated panels are
 *     excluded and the explanation says which and why; nothing unhealthy or drained is
 *     ever picked silently.
 *   - a migration. Existing services are never moved; nothing here reads them.
 *   - a replacement for the explicit route. A product's own panel (its HOME) is used as
 *     before unless the `panel_auto_balancing` flag is on AND the home is in a group; a
 *     panel in no group is routed exactly as it always was.
 */

/** One group member, as the decision sees it. */
export interface PlacementCandidate {
  readonly panelId: string;
  readonly panelName: string;
  readonly providerType: string;
  readonly verdict: PanelEligibility;
  /** HEALTHY and fresh. Anything else that is still eligible ranks after it. */
  readonly healthy: boolean;
  /** Occupied slots: services plus live holds, as the sales gate counts them. */
  readonly used: number;
  readonly maxServices: number | null;
  /** Whether the ordering customer may buy on this panel (reseller entitlement). */
  readonly entitled: boolean;
}

export interface PlacementRow {
  readonly panelId: string;
  readonly panelName: string;
  readonly rank: number | null;
  readonly excluded: PanelPlacementExclusion | null;
  readonly ineligibleReason: PanelIneligibilityReason | null;
  readonly healthy: boolean;
  readonly used: number;
  readonly maxServices: number | null;
  readonly home: boolean;
}

export interface PlacementDecision {
  readonly chosenPanelId: string;
  readonly decidedBy: PanelPlacementDecider;
  /** Every member: the ranked eligible ones first, then the excluded ones by id. */
  readonly candidates: readonly PlacementRow[];
}

type Key = (a: PlacementCandidate, b: PlacementCandidate) => number;

/**
 * The ranking, as an ordered list of keys, each paired with the decider it reports.
 * Earlier keys dominate later ones; the first key that separates the winner from the
 * runner-up is the "why".
 */
function keys(
  strategy: PanelBalancingStrategy,
  homePanelId: string,
): readonly { decider: PanelPlacementDecider; compare: Key }[] {
  return [
    { decider: 'HEALTH', compare: (a, b) => Number(!a.healthy) - Number(!b.healthy) },
    { decider: 'LOAD', compare: loadKey(strategy) },
    {
      decider: 'HOME_PREFERENCE',
      compare: (a, b) => Number(a.panelId !== homePanelId) - Number(b.panelId !== homePanelId),
    },
    {
      decider: 'PANEL_ID',
      compare: (a, b) => (a.panelId < b.panelId ? -1 : a.panelId > b.panelId ? 1 : 0),
    },
  ];
}

/**
 * The load figure, compared exactly: no floats, so two panels at the same share compare
 * equal rather than differing in the last bit.
 */
function loadKey(strategy: PanelBalancingStrategy): Key {
  switch (strategy) {
    case 'LEAST_USED':
      return (a, b) => a.used - b.used;
    case 'LOWEST_UTILISATION':
      return (a, b) => {
        // A panel with no cap has no share; "nobody set a cap" is not "empty", so it
        // ranks after every capped one, and among uncapped panels by slots used.
        if (a.maxServices === null && b.maxServices === null) return a.used - b.used;
        if (a.maxServices === null) return 1;
        if (b.maxServices === null) return -1;
        // a.used / a.max  vs  b.used / b.max, cross-multiplied.
        return a.used * b.maxServices - b.used * a.maxServices;
      };
  }
}

/**
 * The decision, as a pure function: same members, same strategy, same answer, always.
 *
 * Exclusions first, each with its reason: a member of another provider than the home
 * (a product's specification was written for its home's provider), one the customer is
 * not entitled to, one the eligibility evaluator refused. The rest are ranked by health,
 * load, home preference and panel id. With nothing eligible, the HOME is returned and
 * the decider says so — confirmation then refuses for the home's own reason, which is
 * the fallback: never a placement on a panel the evaluator refused.
 */
export function decidePlacement(input: {
  readonly homePanelId: string;
  readonly homeProviderType: string;
  readonly strategy: PanelBalancingStrategy;
  readonly members: readonly PlacementCandidate[];
}): PlacementDecision {
  const exclusionOf = (
    member: PlacementCandidate,
  ): { excluded: PanelPlacementExclusion; reason: PanelIneligibilityReason | null } | null => {
    if (member.providerType !== input.homeProviderType) {
      return { excluded: 'PROVIDER_MISMATCH', reason: null };
    }
    if (!member.entitled) return { excluded: 'NOT_ENTITLED', reason: null };
    if (!member.verdict.eligible) return { excluded: 'INELIGIBLE', reason: member.verdict.reason };
    return null;
  };

  const ordered = keys(input.strategy, input.homePanelId);
  const compare: Key = (a, b) => {
    for (const key of ordered) {
      const result = key.compare(a, b);
      if (result !== 0) return result;
    }
    return 0;
  };

  const eligible = input.members.filter((member) => exclusionOf(member) === null).sort(compare);
  const excluded = input.members
    .filter((member) => exclusionOf(member) !== null)
    .sort((a, b) => (a.panelId < b.panelId ? -1 : a.panelId > b.panelId ? 1 : 0));

  const row = (member: PlacementCandidate, rank: number | null): PlacementRow => {
    const exclusion = exclusionOf(member);
    return {
      panelId: member.panelId,
      panelName: member.panelName,
      rank,
      excluded: exclusion?.excluded ?? null,
      ineligibleReason: exclusion?.reason ?? null,
      healthy: member.healthy,
      used: member.used,
      maxServices: member.maxServices,
      home: member.panelId === input.homePanelId,
    };
  };
  const candidates = [
    ...eligible.map((member, index) => row(member, index + 1)),
    ...excluded.map((member) => row(member, null)),
  ];

  const [first, second] = eligible;
  if (first === undefined) {
    return {
      chosenPanelId: input.homePanelId,
      decidedBy: 'NO_ELIGIBLE_CANDIDATE',
      candidates,
    };
  }
  if (second === undefined) {
    return { chosenPanelId: first.panelId, decidedBy: 'SOLE_CANDIDATE', candidates };
  }
  const decider = ordered.find((key) => key.compare(first, second) !== 0)?.decider ?? 'PANEL_ID';
  return { chosenPanelId: first.panelId, decidedBy: decider, candidates };
}

/** What the draft records about a placement, beside the order. */
export interface PlacementRecord {
  readonly homePanelId: string;
  readonly chosenPanelId: string;
  readonly group: string;
  readonly strategy: PanelBalancingStrategy;
  readonly decidedBy: PanelPlacementDecider;
  readonly candidates: readonly PlacementRow[];
  readonly decidedAt: Date;
}

export interface OrderPlacementRepository {
  /** Written once, in the draft's transaction. */
  record(
    scope: TenantContext,
    orderId: string,
    placement: PlacementRecord,
    tx: TransactionScope,
  ): Promise<void>;
  find(
    scope: TenantContext,
    orderId: string,
    tx?: TransactionScope,
  ): Promise<PlacementRecord | null>;
}

export interface PanelPlacementDeps {
  readonly panels: Pick<PanelRepository, 'find' | 'groupMembers' | 'groupedPanels'>;
  readonly sales: Pick<PanelSalesGate, 'assessMany'>;
  /** `panel_auto_balancing`, read inside the caller's transaction. */
  readonly enabled: (scope: TenantContext, tx?: TransactionScope) => Promise<boolean>;
  /** `panels.balancing.strategy`, read inside the caller's transaction. */
  readonly strategy: (
    scope: TenantContext,
    tx: TransactionScope,
  ) => Promise<PanelBalancingStrategy>;
  readonly clock: Clock;
}

export class PanelPlacementService {
  constructor(private readonly deps: PanelPlacementDeps) {}

  /**
   * Where a NEW account for a product bound to `homePanelId` goes.
   *
   * `placement` is null when balancing was not considered — the flag off, or the home in
   * no group — and the panel is then the home, the explicit route, unchanged. The caller
   * writes the order on `panelId` and records `placement` beside it.
   *
   * `entitled` is the ordering customer's own rule (a reseller's tier may grant some
   * panels and not others), asked per member so a placement never chooses a panel the
   * order would then be refused on.
   */
  async place(
    scope: TenantContext,
    input: {
      readonly homePanelId: string;
      /**
       * Synchronous, and that is the point (Codex on #163): it is a pure decision over
       * grants the caller has ALREADY read, never a read per member under the draft's
       * locks. The caller passes `() => true` for an ordinary customer.
       */
      readonly entitled: (panelId: string) => boolean;
    },
    tx: TransactionScope,
  ): Promise<{ panelId: string; placement: PlacementRecord | null }> {
    const fixed = { panelId: input.homePanelId, placement: null };
    if (!(await this.deps.enabled(scope, tx))) return fixed;
    const home = await this.deps.panels.find(scope, input.homePanelId, tx);
    if (home === null || home.panel.balancingGroup === null) return fixed;
    /*
     * Only a LIVE home is balanced (Codex on #163). An ARCHIVED panel keeps its group label,
     * so without this a product still pointing at one would be placed on a peer and walk
     * round the ARCHIVED refusal its own panel answers. DISABLED is treated the same, for
     * the same reason and to agree with the catalogue's reach: the operator said "stop
     * using this panel", and its products are paused, not redirected. A DRAINED home is
     * ACTIVE and is balanced — sending its new accounts elsewhere is what drain is for.
     */
    if (home.panel.status !== 'ACTIVE') return fixed;
    const group = home.panel.balancingGroup;

    const views = await this.deps.panels.groupMembers(scope, group, tx);
    const assessed = await this.deps.sales.assessMany(
      scope,
      views.map((view) => view.panel.id),
      tx,
    );
    const now = this.deps.clock.now();
    const members: PlacementCandidate[] = [];
    for (const listed of views) {
      const assessment = assessed.get(listed.panel.id);
      if (assessment === undefined) continue;
      /*
       * `assessment.view`, NOT the member list's row (Codex on #163): the verdict was
       * decided from the row `assessMany` read, and ranking from an earlier read could
       * pair one panel's health with another moment's eligibility.
       */
      members.push(
        this.candidateOf(
          assessment.view,
          assessment.capacity,
          assessment.verdict,
          now,
          input.entitled,
        ),
      );
    }
    const strategy = await this.deps.strategy(scope, tx);
    const decision = decidePlacement({
      homePanelId: input.homePanelId,
      homeProviderType: home.panel.providerType,
      strategy,
      members,
    });
    return {
      panelId: decision.chosenPanelId,
      placement: {
        homePanelId: input.homePanelId,
        chosenPanelId: decision.chosenPanelId,
        group,
        strategy,
        decidedBy: decision.decidedBy,
        candidates: decision.candidates,
        decidedAt: now,
      },
    };
  }

  /**
   * The catalogue's reach: which panels' products may be OFFERED, given the panels the
   * sales gate calls eligible.
   *
   * With balancing off it is exactly `eligible`. With it on, a product whose own panel is
   * full, drained or down is still offered when another panel of its group and provider
   * could take the account — the draft will be placed there. A courtesy, as every
   * catalogue answer is: the draft places, and confirmation decides.
   */
  async reachableHomes(
    scope: TenantContext,
    eligible: readonly string[],
    tx?: TransactionScope,
  ): Promise<readonly string[]> {
    if (!(await this.deps.enabled(scope, tx))) return eligible;
    const grouped = await this.deps.panels.groupedPanels(scope, tx);
    const eligibleSet = new Set(eligible);
    const open = new Set(
      grouped
        .filter((panel) => eligibleSet.has(panel.id))
        .map((panel) => `${panel.group}\u0000${panel.providerType}`),
    );
    const reach = new Set(eligible);
    for (const panel of grouped) {
      // Only a LIVE home is widened — the same rule `place` applies, so the catalogue
      // never offers a product the draft would then keep on its disabled panel.
      if (panel.status !== 'ACTIVE') continue;
      if (open.has(`${panel.group}\u0000${panel.providerType}`)) reach.add(panel.id);
    }
    return [...reach];
  }

  private candidateOf(
    view: PanelView,
    capacity: PanelCapacity | null,
    verdict: PanelEligibility,
    now: Date,
    entitled: (panelId: string) => boolean,
  ): PlacementCandidate {
    const health = readHealth(view.panel, view.health, now);
    return {
      panelId: view.panel.id,
      panelName: view.panel.name,
      providerType: view.panel.providerType,
      verdict,
      healthy: health.state === 'HEALTHY' && !health.stale,
      used: capacity?.used ?? 0,
      maxServices: capacity?.maxServices ?? view.panel.maxServices,
      entitled: entitled(view.panel.id),
    };
  }
}
