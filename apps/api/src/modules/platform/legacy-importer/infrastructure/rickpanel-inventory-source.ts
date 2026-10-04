import type {
  ProviderHttpClient,
  ProviderHttpRequest,
  ProviderHttpResult,
  TenantContext,
} from '@nexa/contracts';
import { toProviderCredentials } from '../../panels/application/probe-core.js';
import {
  RickpanelInventoryReader,
  inventoryIndex,
  readOnlyRickpanelHttp,
} from '../../providers/infrastructure/rickpanel-inventory.js';
import { TOKEN_PATH } from '../../providers/infrastructure/rickpanel-protocol.js';
import type {
  AccountRuntime,
  LegacyInventoryPort,
  LegacyInventoryRead,
} from '../application/ports.js';

/**
 * Migration P7 — the importer's ONLY provider surface, READ ONLY by construction
 * (`docs/legacy-migration/importer.md` §Provider).
 *
 * Two walls between the importer and a RickPanel write:
 *
 * 1. It holds `RickpanelInventoryReader` and a `RickpanelReadOnlyHttp` — three fixed reads,
 *    no method, path or body a caller supplies (`docs/rickpanel-inventory.md`). It never
 *    imports `RickpanelAdapter` and never holds a `ProviderHttpAdapter` that could create,
 *    renew, add traffic or time, enable, disable, delete, rename or rotate.
 * 2. Underneath, the client it narrows is wrapped by `readOnlyGuard`, which REFUSES,
 *    without sending, anything that is not a `GET` or the token exchange, and counts it.
 *    The reconcile requires that count to be zero; the integration suite's fake panel
 *    records every request it receives and requires every one to be a read.
 *
 * Each panel is read with `listAll` — two consecutive walks that must agree — so the
 * matcher only ever sees a COMPLETE inventory; anything else is `INVENTORY_INCOMPLETE`.
 */

export interface PanelReadAccess {
  /** The panel's address and provider type, in this tenant; null when it is not one. */
  panel(
    scope: TenantContext,
    panelId: string,
  ): Promise<{ readonly baseUrl: string; readonly providerType: string } | null>;
  /** The decrypted credentials. Used for the token exchange and never kept or printed. */
  credentials(
    scope: TenantContext,
    panelId: string,
  ): Promise<{ username: string | null; password: string | null; apiToken: string | null } | null>;
  /** The installation's panel client (URL policy, timeouts, response cap) for an address. */
  http(baseUrl: string): ProviderHttpClient;
}

/** The read-only rule, as a client wrapper. Exported for its own test. */
export function readOnlyGuard(
  http: ProviderHttpClient,
  counts: { reads: number; refusedWrites: number },
): ProviderHttpClient {
  return {
    send: async (request: ProviderHttpRequest): Promise<ProviderHttpResult> => {
      const isRead =
        (request.method === 'GET' && request.effect === 'READ') ||
        (request.method === 'POST' && request.effect === 'READ' && request.path === TOKEN_PATH);
      if (!isRead) {
        counts.refusedWrites += 1;
        return { ok: false, failure: 'BLOCKED_TARGET', status: null };
      }
      counts.reads += 1;
      return http.send(request);
    },
  };
}

export class RickpanelInventorySource implements LegacyInventoryPort {
  private readonly reader = new RickpanelInventoryReader();
  private readonly counts = { reads: 0, refusedWrites: 0 };

  constructor(
    private readonly access: PanelReadAccess,
    private readonly options: { readonly pageSize?: number } = {},
    private readonly now: () => Date = () => {
      throw new Error('RickpanelInventorySource needs the Clock to stamp a read');
    },
  ) {}

  requestCounts(): { readonly reads: number; readonly refusedWrites: number } {
    return { ...this.counts };
  }

  async read(scope: TenantContext, panelId: string): Promise<LegacyInventoryRead> {
    const panel = await this.access.panel(scope, panelId);
    if (panel === null || panel.providerType !== 'rickpanel') {
      return { ok: false, failure: 'NOT_A_RICKPANEL' };
    }
    const credentials = toProviderCredentials(
      await this.access.credentials(scope, panelId),
      'USERNAME_PASSWORD',
    );
    if (credentials === null) return { ok: false, failure: 'CREDENTIALS_MISSING' };
    const http = readOnlyRickpanelHttp(readOnlyGuard(this.access.http(panel.baseUrl), this.counts));
    const outcome = await this.reader.listAll(
      { baseUrl: panel.baseUrl, credentials },
      http,
      this.options.pageSize === undefined ? {} : { pageSize: this.options.pageSize },
    );
    if (!outcome.ok) return { ok: false, failure: outcome.failure };
    if (!outcome.complete) return { ok: true, complete: false, reason: outcome.reason };
    const index = inventoryIndex(panelId, outcome);
    if (index === null) return { ok: true, complete: false, reason: 'NOT_INDEXABLE' };
    const states: Record<string, number> = {};
    // The runtime facts P6 adopts from, from the SAME complete walk as the index — never
    // a second read that could describe a different moment. No link: subscription links
    // are not carried by the inventory (`docs/rickpanel-inventory.md`), and P6 adopts
    // with a null link safely (C3); deriving one would need the adapter module.
    const runtime = new Map<string, AccountRuntime>();
    for (const account of outcome.accounts) {
      states[account.state] = (states[account.state] ?? 0) + 1;
      runtime.set(account.providerUsername, {
        state: account.state,
        usage:
          account.usage === null
            ? null
            : {
                usedBytes: account.usage.usedBytes,
                totalBytes: account.usage.totalBytes,
                expiresAt: account.usage.expiresAt,
              },
      });
    }
    return {
      ok: true,
      complete: true,
      index,
      accounts: outcome.accounts.length,
      states,
      runtime,
      observedAt: this.now(),
    };
  }
}
