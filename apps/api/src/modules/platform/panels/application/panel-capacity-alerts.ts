import { PANEL_CAPACITY_WARNING_PERCENT, type OperationalSeverity } from '@nexa/contracts';
import type { PanelCapacity } from './capacity-ports.js';

/**
 * A panel is nearly full.
 *
 * WARN and not ERROR: nothing is refused yet and every sale still completes.
 * What an operator does about it — raise the cap, add a panel, stop selling the
 * plan — takes longer than the gap between "nearly full" and "full", which is
 * the whole reason this condition exists separately from the one below.
 */
export const CAPACITY_WARNING_CODE = 'panel.capacity.warning';
/**
 * A panel is full: every slot is taken by a service or an unexpired hold.
 *
 * ERROR, because the product is now REFUSING money. `decideEligibility` answers
 * `AT_CAPACITY`, the catalogue hides the plan and a confirmation is refused —
 * all correct, all invisible unless somebody is told.
 */
export const CAPACITY_FULL_CODE = 'panel.capacity.full';
/**
 * A panel has no capacity condition any more.
 *
 * The recovery for BOTH conditions above, and it is one code rather than two
 * because a recovery's job is to CLOSE the row that is open: which one that is
 * comes from the open set, not from the recovery's own name. Two recovery codes
 * would need the same read and would leave the operator two rows to reconcile.
 */
export const CAPACITY_RECOVERED_CODE = 'panel.capacity.recovered';

/**
 * The three codes, in the order a superseded row is looked for.
 *
 * Exported because the monitor asks which of them is open before deciding, and
 * a second list written out there is the way the reader and the decision come
 * to disagree about what a panel can have open.
 */
export const CAPACITY_CODES = [
  CAPACITY_FULL_CODE,
  CAPACITY_WARNING_CODE,
  CAPACITY_RECOVERED_CODE,
] as const;

/** One per PANEL and CONDITION, the format `panelConditionKey` establishes. */
export function capacityConditionKey(code: string, panelId: string): string {
  return `${code}:${panelId}`;
}

export interface CapacityAlert {
  readonly code: string;
  readonly severity: OperationalSeverity;
  readonly message: string;
  readonly dedupeKey: string;
  /**
   * The ONE row this event closes, or nothing when there is nothing to close.
   *
   * `recoversCode` is singular in the recorder, which is exactly why the
   * decision below is written against the open set: three states and one
   * recovery slot only work if each event closes the row the panel is LEAVING.
   */
  readonly recoversCode?: string;
  readonly recoversDedupeKey?: string;
  readonly context: Record<string, unknown>;
}

/**
 * Which capacity condition a panel's occupancy earns, given what is open.
 *
 * The invariant this maintains is AT MOST ONE open capacity row per panel, and
 * every branch below exists to keep it — because `recoversCode` closes one code
 * and a panel that filled, warned and then drained would otherwise leave an
 * ERROR standing for ever on a panel that is fine. Same failure the health
 * transitions avoid by closing the condition they are LEAVING; capacity has no
 * stored previous condition, so it reads the open rows instead.
 *
 * `null` is "record nothing", and it is the steady state: an uncapped panel, or
 * a capped one under the threshold with no row open, says nothing at all. A
 * tick that recorded an INFO row for every healthy panel would produce an
 * operations log whose every page is panels that are fine.
 *
 * NOTE that an uncapped panel is not unconditionally silent. Removing a cap is
 * an operator's own remedy for a full panel, and the condition it was raised
 * about stops being true at that moment — so an open row is still closed, by
 * the same branch that closes it when occupancy falls.
 */
export function capacityAlertFor(
  panelId: string,
  capacity: PanelCapacity,
  open: readonly string[],
): CapacityAlert | null {
  const cap = capacity.maxServices;
  const context = {
    used: capacity.used,
    services: capacity.services,
    reservations: capacity.reservations,
    maxServices: cap,
  };
  const openSet = new Set(open);
  const closing = (code: string): Pick<CapacityAlert, 'recoversCode' | 'recoversDedupeKey'> => ({
    recoversCode: code,
    recoversDedupeKey: capacityConditionKey(code, panelId),
  });

  const desired = desiredCondition(capacity, cap);

  if (desired === null) {
    /*
     * Nothing to say — unless something is standing that is no longer true.
     * The recovery is recorded ONLY then, which is also what keeps it visible:
     * a recovery row that is already open is merely incremented, so a tick that
     * recorded one unconditionally would spend the panel's single recovery row
     * long before the next condition needed it.
     */
    const standing = [CAPACITY_FULL_CODE, CAPACITY_WARNING_CODE].find((code) => openSet.has(code));
    if (standing === undefined) return null;
    return {
      code: CAPACITY_RECOVERED_CODE,
      severity: 'INFO',
      message:
        cap === null
          ? `is no longer capped, so its capacity condition no longer applies`
          : `is back under its capacity warning threshold: ${capacity.used} of ${cap} slots are taken`,
      dedupeKey: capacityConditionKey(CAPACITY_RECOVERED_CODE, panelId),
      ...closing(standing),
      context,
    };
  }

  /*
   * A condition, closing whichever OTHER capacity row is open — the one the
   * panel is leaving, whether that is the warning it has now passed or the
   * recovery that said it was fine. When the same condition is already open
   * there is nothing to close and the recorder increments it: an open row's
   * occurrence counter is what says a condition is still true, and pointing a
   * row's recovery at its own code would resolve the row this tick just
   * reopened.
   */
  const superseded = CAPACITY_CODES.find((code) => code !== desired.code && openSet.has(code));
  return {
    code: desired.code,
    severity: desired.severity,
    message: desired.message,
    dedupeKey: capacityConditionKey(desired.code, panelId),
    ...(superseded === undefined ? {} : closing(superseded)),
    context,
  };
}

/** Full, nearly full, or neither. Occupancy only — nothing about what is open. */
function desiredCondition(
  capacity: PanelCapacity,
  cap: number | null,
): { code: string; severity: OperationalSeverity; message: string } | null {
  if (cap === null) return null;
  if (capacity.used >= cap) {
    return {
      code: CAPACITY_FULL_CODE,
      severity: 'ERROR',
      message: `is full: ${capacity.used} of ${cap} slots are taken, so new sales on it are refused`,
    };
  }
  /*
   * The threshold is a PERCENTAGE of the cap, rounded up, so a cap of 1 warns
   * at 1 — which is also full, so the branch above answers first and this one
   * cannot produce a warning that is really a full panel.
   */
  const threshold = Math.ceil((cap * PANEL_CAPACITY_WARNING_PERCENT) / 100);
  if (capacity.used >= threshold) {
    return {
      code: CAPACITY_WARNING_CODE,
      severity: 'WARN',
      message: `is nearly full: ${capacity.used} of ${cap} slots are taken`,
    };
  }
  return null;
}
