import type { PanelId, TenantContext } from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { PanelSalesGate } from '../../../platform/panels/application/panel-sales-gate.js';
import type { PanelRepository } from '../../../platform/panels/application/ports.js';
import type { OrderUsernameLane } from '../../provisioning/application/username-lane.js';
import type { PanelTrialConfigRecord, PanelTrialConfigRepository } from './ports.js';

/** One panel a customer may take a trial on, as the choice shows it. */
export interface TrialOffer {
  readonly panelId: PanelId;
  /** The trial's own name, else the panel's. */
  readonly label: string;
  readonly trafficBytes: bigint;
  readonly durationHours: number;
}

/** One configured panel, and whether it is offered NOW. */
export interface TrialPanelVerdict {
  readonly config: PanelTrialConfigRecord;
  /** Null for a panel this tenant no longer has — which no foreign key permits. */
  readonly panelName: string | null;
  readonly offered: boolean;
}

export interface TrialOfferDeps {
  readonly configs: Pick<PanelTrialConfigRepository, 'list'>;
  /** THE eligibility evaluator (`decideEligibility`), read-only. */
  readonly panelSales: Pick<PanelSalesGate, 'evaluateMany'>;
  readonly panels: Pick<PanelRepository, 'findMany'>;
  readonly usernames: Pick<OrderUsernameLane, 'modesFor'>;
}

/**
 * THE answer to "which panels offer a trial right now" (R1): a panel whose trial is
 * enabled AND which the one eligibility evaluator lets take a new account AND whose
 * username policy lets the installation choose the name — a trial has no step where the
 * customer types one.
 *
 * Three callers and no fourth predicate: the bot's offer (one panel → straight to the
 * claim, several → a choice, none → one sentence), the catalogue's trial button, and the
 * operator's overview. All three are courtesies. The claim decides the trial again inside
 * its transaction — the configuration under the customer's lock, the panel under its own
 * lock through `prepareFulfilment`, the name through the username lane — so a panel that
 * stopped qualifying between the offer and the tap is refused, not issued.
 */
export async function trialPanelVerdicts(
  deps: TrialOfferDeps,
  scope: TenantContext,
  tx?: TransactionScope,
): Promise<readonly TrialPanelVerdict[]> {
  const configs = await deps.configs.list(scope, tx);
  if (configs.length === 0) return [];
  const ids = configs.map((config) => config.panelId);
  const enabled = configs.filter((config) => config.enabled).map((config) => config.panelId);
  const eligibility = await deps.panelSales.evaluateMany(scope, enabled, tx);
  const names = new Map(
    (await deps.panels.findMany(scope, ids, tx)).map((view) => [view.panel.id, view.panel.name]),
  );
  const verdicts: TrialPanelVerdict[] = [];
  for (const config of configs) {
    const panelName = names.get(config.panelId) ?? null;
    let offered = config.enabled && panelName !== null;
    if (offered) offered = eligibility.get(config.panelId)?.eligible === true;
    if (offered) {
      offered = (await deps.usernames.modesFor(scope, config.panelId, tx)).includes('AUTOMATIC');
    }
    verdicts.push({ config, panelName, offered });
  }
  return verdicts;
}

/** The offered panels, as the customer's choice lists them: by name, then id. */
export async function trialOffersFor(
  deps: TrialOfferDeps,
  scope: TenantContext,
  tx?: TransactionScope,
): Promise<readonly TrialOffer[]> {
  const offers = (await trialPanelVerdicts(deps, scope, tx))
    .filter((verdict) => verdict.offered)
    .map((verdict) => ({
      panelId: verdict.config.panelId,
      label: verdict.config.label ?? verdict.panelName ?? '',
      trafficBytes: verdict.config.trafficBytes,
      durationHours: verdict.config.durationHours,
    }));
  return offers.sort((a, b) =>
    a.label === b.label ? a.panelId.localeCompare(b.panelId) : a.label.localeCompare(b.label),
  );
}
