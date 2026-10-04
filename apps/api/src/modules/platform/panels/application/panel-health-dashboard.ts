import {
  isSystemContext,
  PANEL_HEALTH_FAILURE_WINDOW_MS,
  type ActorContext,
  type Clock,
  type OperationalSeverity,
  type PanelHealthState,
  type ProviderFailureKind,
  type ScopeContext,
  type TenantContext,
} from '@nexa/contracts';
import { CAPACITY_CODES } from './panel-capacity-alerts.js';
import type { PanelWithCapacity } from './capacity-ports.js';
import {
  conditionOf,
  PANEL_HEALTH_CONDITION_CODES,
  panelConditionKey,
} from './panel-monitor.service.js';
import type { PanelArchiveScope, PanelCursor } from './ports.js';

/**
 * The panel health dashboard (Phase C2): the live fleet, one row per panel, with
 * what each panel is doing and what has gone wrong with it.
 *
 * READ-ONLY, and every number on it is something this installation already
 * records. It invents no history: `panel_health` is latest-state-only (ADR-0023),
 * so the dashboard shows the latest probe, its latency, the last time the panel
 * answered and the stored unusable streak — never an uptime percentage or a
 * latency trend that would need probes nobody kept.
 *
 * Composed from three existing sources rather than a fourth opinion:
 *
 *   - `PanelService.list` — the same page the panel list serves, so health,
 *     capacity, sellability (the ONE evaluator, `DRAINING` included) and drain
 *     are computed by the code every other screen uses. It also charges
 *     `panels.view`, which is this read's permission.
 *   - `PanelFleetStatsReader` — services by state and provisioning operations
 *     that FAILED in the window or sit UNKNOWN, per panel, one grouped query
 *     each for the whole page.
 *   - the ops log — the panel's OPEN health and capacity conditions, found by the
 *     exact dedupe keys the monitor and the capacity alerts write. A failure is
 *     recorded once, by them; this screen reads it.
 *
 * ## The hook for the Notification Center (B3)
 *
 * Nothing here notifies anyone, and that is deliberate: the conditions this
 * screen lists are already rows in `operational_events`, written in the probe's
 * own transaction by the monitor, with dedupe and an explicit recovery. B3
 * should subscribe to THOSE rows — the codes `PANEL_CONDITION_CODES` lists, keyed
 * `panelConditionKey(code, panelId)` — rather than to this read, so a panel going
 * down is announced whether or not anybody has this page open.
 */
export interface PanelFleetStats {
  readonly services: {
    readonly active: number;
    readonly suspended: number;
    readonly expired: number;
    readonly pending: number;
    readonly unreconciled: number;
  };
  readonly provisioning: {
    readonly failedInWindow: number;
    readonly unknownOpen: number;
    readonly lastFailureAt: Date | null;
    readonly lastFailureKind: ProviderFailureKind | null;
  };
}

export const EMPTY_FLEET_STATS: PanelFleetStats = {
  services: { active: 0, suspended: 0, expired: 0, pending: 0, unreconciled: 0 },
  provisioning: { failedInWindow: 0, unknownOpen: 0, lastFailureAt: null, lastFailureKind: null },
};

/** Tenant-scoped, bounded by the page of panel ids it is given. */
export interface PanelFleetStatsReader {
  statsFor(
    scope: TenantContext,
    panelIds: readonly string[],
    /** Half-open `[since, until)`. */
    window: { readonly since: Date; readonly until: Date },
  ): Promise<ReadonlyMap<string, PanelFleetStats>>;
}

export interface OpenConditionDetail {
  readonly dedupeKey: string;
  readonly code: string;
  readonly severity: OperationalSeverity;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly occurrences: number;
}

/** The unresolved ops-log rows among these dedupe keys, for this scope. */
export interface OpenConditionDetailReader {
  openConditionDetails(
    scope: ScopeContext,
    dedupeKeys: readonly string[],
  ): Promise<readonly OpenConditionDetail[]>;
}

/**
 * Every code a panel's health or capacity condition can be open under.
 *
 * DERIVED from `conditionOf` over every state and failure kind, never typed out:
 * a code the monitor learns to write is on this list the moment it exists, and a
 * list kept by hand beside it is the second opinion that would silently stop
 * showing a new failure. Capacity codes are the alerts' own exported list.
 */
export const PANEL_CONDITION_CODES: readonly string[] = [
  ...new Set([...PANEL_HEALTH_CONDITION_CODES, ...CAPACITY_CODES]),
].sort();

/**
 * Whether an open condition describes the panel AS IT IS NOW (UX batch 01, item 10).
 *
 * A health condition is current only while the stored health still produces its
 * code: one left open after the panel recovered — by a release whose operator test
 * announced nothing — is HISTORY awaiting its close, and the screen must not
 * present it as an active provider failure. The next healthy probe closes it
 * (`announceHealthWrite`); until then it is labelled as what it is.
 *
 * A capacity condition is about occupancy, which this row does not measure, so it
 * is taken as current: the monitor's capacity observer is what closes it.
 */
export function isCurrentCondition(
  code: string,
  health: { state: PanelHealthState; failure: ProviderFailureKind | null } | null,
): boolean {
  if (!PANEL_HEALTH_CONDITION_CODES.includes(code)) return true;
  // No stored health proves nothing either way, and a condition this screen
  // cannot disprove is not demoted to history.
  if (health === null) return true;
  return conditionOf(health.state, health.failure)?.code === code;
}

export interface PanelHealthDashboardRow {
  readonly panel: PanelWithCapacity;
  readonly stats: PanelFleetStats;
  readonly conditions: readonly (OpenConditionDetail & { readonly current: boolean })[];
}

export interface PanelHealthDashboardDeps {
  readonly panels: {
    list(
      scope: ScopeContext,
      actor: ActorContext,
      page: { limit?: number; cursor?: PanelCursor | null; archived?: PanelArchiveScope },
    ): Promise<{ panels: PanelWithCapacity[]; nextCursor: PanelCursor | null }>;
  };
  readonly stats: PanelFleetStatsReader;
  readonly conditions: OpenConditionDetailReader;
  readonly clock: Clock;
}

export class PanelHealthDashboardService {
  constructor(private readonly deps: PanelHealthDashboardDeps) {}

  async page(
    scope: ScopeContext,
    actor: ActorContext,
    page: { limit?: number; cursor?: PanelCursor | null },
  ): Promise<{
    rows: PanelHealthDashboardRow[];
    nextCursor: PanelCursor | null;
    generatedAt: Date;
    failureWindowMs: number;
  }> {
    // `list` charges `panels.view` and resolves the tenant: nothing below runs for
    // an actor it refused.
    const listed = await this.deps.panels.list(scope, actor, { ...page, archived: 'LIVE' });
    const generatedAt = this.deps.clock.now();
    const ids = listed.panels.map((view) => view.panel.id);
    if (ids.length === 0) {
      return {
        rows: [],
        nextCursor: listed.nextCursor,
        generatedAt,
        failureWindowMs: PANEL_HEALTH_FAILURE_WINDOW_MS,
      };
    }
    // `list` has already refused a system scope (panels are tenant-scoped), so this
    // narrowing cannot fail here; it is the same rule, not a second one.
    if (isSystemContext(scope)) throw new Error('panel health is tenant-scoped');
    const tenantScope: TenantContext = scope;
    const stats = await this.deps.stats.statsFor(tenantScope, ids, {
      since: new Date(generatedAt.getTime() - PANEL_HEALTH_FAILURE_WINDOW_MS),
      until: generatedAt,
    });
    const keys = ids.flatMap((id) =>
      PANEL_CONDITION_CODES.map((code) => panelConditionKey(code, id)),
    );
    const open = await this.deps.conditions.openConditionDetails(scope, keys);
    const byPanel = new Map<string, OpenConditionDetail[]>();
    for (const row of open) {
      // The key is `${code}:${panelId}` by construction (`panelConditionKey`).
      const panelId = row.dedupeKey.slice(row.dedupeKey.lastIndexOf(':') + 1);
      const list = byPanel.get(panelId) ?? [];
      list.push(row);
      byPanel.set(panelId, list);
    }
    return {
      rows: listed.panels.map((view) => ({
        panel: view,
        stats: stats.get(view.panel.id) ?? EMPTY_FLEET_STATS,
        conditions: (byPanel.get(view.panel.id) ?? [])
          .sort(
            (a, b) =>
              b.lastSeenAt.getTime() - a.lastSeenAt.getTime() || a.code.localeCompare(b.code),
          )
          .map((condition) => ({
            ...condition,
            current: isCurrentCondition(condition.code, view.health),
          })),
      })),
      nextCursor: listed.nextCursor,
      generatedAt,
      failureWindowMs: PANEL_HEALTH_FAILURE_WINDOW_MS,
    };
  }
}
