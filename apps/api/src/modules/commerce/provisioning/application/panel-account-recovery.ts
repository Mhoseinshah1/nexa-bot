import {
  SERVICE_PANEL_ACCOUNT_FOUND_CODE,
  SERVICE_PANEL_ACCOUNT_MISSING_CODE,
  servicePanelAccountMissingKey,
  type OperationalEventRecorder,
  type TenantContext,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';

/** Which of one subject's conditions is open — the opslog's condition reader. */
export interface ServiceConditionReader {
  conditionIsOpen(scope: TenantContext, dedupeKey: string, tx?: TransactionScope): Promise<boolean>;
}

export interface PanelAccountRecoveryDeps {
  readonly conditions: ServiceConditionReader;
  readonly opsEvents: Pick<OperationalEventRecorder, 'record'>;
}

/**
 * Track 3 §1: a usage read that SUCCEEDED proves the panel holds this service's account,
 * so an open `service.panel_account_missing` condition for it is closed — by the ordinary
 * recorder, inside the caller's transaction, about this service only.
 *
 * Called from EVERY place a successful usage read is written (`recordUsage` returned
 * true): the card's live check, the «♻️» button, the scheduled `SYNC_USAGE` and the usage
 * a commercial modify returned. One writer of the figure that forgot this would leave the
 * condition open for ever: the next card open would find a fresh `usage_synced_at`,
 * answer from the cache, and never read the panel again to close it (Codex on #291).
 *
 * Nothing is recorded when no condition is open, so a healthy service writes no rows.
 */
export async function closePanelAccountMissing(
  deps: PanelAccountRecoveryDeps,
  scope: TenantContext,
  service: { readonly id: string; readonly panelId: string },
  tx: TransactionScope,
): Promise<boolean> {
  const key = servicePanelAccountMissingKey(service.id);
  if (!(await deps.conditions.conditionIsOpen(scope, key, tx))) return false;
  await deps.opsEvents.record(
    scope,
    {
      code: SERVICE_PANEL_ACCOUNT_FOUND_CODE,
      severity: 'INFO',
      message: 'The panel holds this service’s account again.',
      context: { serviceId: service.id, panelId: service.panelId },
      recoversCode: SERVICE_PANEL_ACCOUNT_MISSING_CODE,
      recoversDedupeKey: key,
    },
    tx,
  );
  return true;
}
