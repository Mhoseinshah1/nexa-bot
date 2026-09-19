import {
  PANEL_HEALTH_FRESH_FOR_MS,
  type PanelHealthView as PanelHealthViewState,
  type ProviderFailureKind,
} from '@nexa/contracts';
import type { PanelHealthSnapshot, PanelRecord } from './ports.js';

/**
 * Health, as an OPERATOR reads it, wherever they read it.
 *
 * Three things a stored state cannot say on its own, and each is projected here
 * rather than persisted:
 *
 *   `DISABLED`  — from the panel's status. Storing it would mean re-enabling a
 *                 panel required a health write, and the health of a panel
 *                 nobody is probing is not a fact about the panel.
 *   `UNCHECKED` — the absence of a row. Inventing a row to record that nothing
 *                 has happened makes a never-checked panel look checked, which
 *                 is the legacy statistics screen's mistake: it counted
 *                 CONFIGURED panels and called them connected.
 *   `stale`     — computed against ONE constant so two surfaces cannot disagree
 *                 about what "recent" means.
 *
 * ## Why it is a function and not two copies
 *
 * It was two copies for about an hour. The Web Admin controller held this
 * arithmetic and the Telegram panels section needed the same three answers, and
 * "two surfaces recompute the same concept differently" is the failure this
 * repository has a measured example of: `docs/research` records a web "total
 * revenue" and a Telegram `مجموع فروش` that differ by 38%. A projection that
 * decides whether a panel reads as DISABLED is exactly that shape of concept —
 * cheap to copy, and invisible when the copies drift.
 *
 * It lives in the application layer rather than in either surface because both
 * surfaces are allowed to call it from there and neither is allowed to import
 * the other.
 */
export interface PanelHealthReading {
  readonly state: PanelHealthViewState;
  readonly checkedAt: Date | null;
  readonly failure: ProviderFailureKind | null;
  readonly stale: boolean;
}

export function readHealth(
  panel: Pick<PanelRecord, 'status'>,
  health: PanelHealthSnapshot | null,
  now: Date,
): PanelHealthReading {
  if (health === null) {
    return {
      state: panel.status === 'ACTIVE' ? 'UNCHECKED' : 'DISABLED',
      checkedAt: null,
      failure: null,
      /*
       * Never stale, because there is nothing to be stale. A panel with no probe
       * is `UNCHECKED` and saying it is ALSO out of date invents a previous
       * answer it never had.
       */
      stale: false,
    };
  }
  return {
    state: panel.status === 'ACTIVE' ? health.state : 'DISABLED',
    checkedAt: health.checkedAt,
    failure: health.failure,
    stale: now.getTime() - health.checkedAt.getTime() > PANEL_HEALTH_FRESH_FOR_MS,
  };
}
