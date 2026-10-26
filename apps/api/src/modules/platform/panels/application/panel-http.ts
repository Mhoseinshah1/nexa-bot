import type { ProviderHttpClient } from '@nexa/contracts';
import type { SafeHttpClient } from '../../../../infrastructure/net/safe-http.js';

/**
 * The HTTP client for ONE panel, with that panel's own deadline when it declares one
 * (R10 C2).
 *
 * Every binding of a panel's base URL goes through here, so a per-panel timeout applies
 * to the operator's connection test, the background monitor, provisioning, the live
 * service check and the subscription-file read alike — a timeout that held in four of
 * those places and not the fifth would be the copy that drifts.
 *
 * Read STRUCTURALLY from the stored activation, never by provider type: only a schema
 * that declares `requestTimeoutMs` (today, `customActivationSchema`) can have stored it,
 * because every activation is parsed against its own provider's schema before it is
 * written. `SafeHttpClient.forBase` then takes the SMALLER of it and the installation's
 * `PANEL_HTTP_TIMEOUT_MS`, so a panel can be made to give up sooner and never later.
 */
export function panelRequestTimeoutMs(activation: unknown): number | undefined {
  if (typeof activation !== 'object' || activation === null || Array.isArray(activation)) {
    return undefined;
  }
  const value = (activation as Record<string, unknown>)['requestTimeoutMs'];
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function panelClient(
  http: Pick<SafeHttpClient, 'forBase'>,
  panel: { readonly baseUrl: string; readonly activation: unknown },
): ProviderHttpClient {
  const timeoutMs = panelRequestTimeoutMs(panel.activation);
  return timeoutMs === undefined
    ? http.forBase(panel.baseUrl)
    : http.forBase(panel.baseUrl, { timeoutMs });
}
