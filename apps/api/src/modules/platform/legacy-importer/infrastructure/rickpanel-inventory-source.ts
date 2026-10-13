import type {
  ProviderHttpClient,
  ProviderHttpRequest,
  ProviderHttpResult,
  TenantContext,
} from '@nexa/contracts';
import { toProviderCredentials } from '../../panels/application/probe-core.js';
import {
  RickpanelInventoryReader,
  effectiveInventoryPageSize,
  inventoryIndex,
  readOnlyRickpanelHttp,
  type RickpanelInventoryOutcome,
} from '../../providers/infrastructure/rickpanel-inventory.js';
import { TOKEN_PATH } from '../../providers/infrastructure/rickpanel-protocol.js';
import type {
  AccountRuntime,
  LegacyInventoryDiagnostics,
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
 *
 * ## Attempts (DRY_RUN_MISMATCH)
 *
 * Opt-in (`attempts`; the Web Admin's `.nxpkg` importer asks for `INVENTORY_READ_ATTEMPTS`;
 * every other caller — the CLI, the rehearsal walk — reads once, as before). A live panel that
 * moves during a walk — or one that did not answer a page in time — is read again, up to
 * `attempts` double walks, with a pause before each. The
 * criterion is NOT relaxed by it: every attempt is a full `listAll`, and only an attempt that
 * is complete on its own is ever indexed. What the attempts change is how often a dry run and
 * an import each settle on a complete read of the same panel, rather than one of them
 * plan on an incomplete one and the other on a complete one (another digest).
 *
 * Retried: an incomplete answer (`TOTAL_CHANGED`, `COUNT_MISMATCH`, `WALKS_DIFFER`) and, on a
 * LIST page, the failures that say nothing about the panel's answer: `TIMEOUT`, `UNREACHABLE`,
 * `RATE_LIMITED`, and `PROVIDER_ERROR` without a status or with a 5xx. At the LOGIN only
 * `TIMEOUT` and `UNREACHABLE`: any answer the token exchange gave (a 400, a 401, a 429) is one
 * more failed login if asked again, and a panel that limits logins turns those into a lockout.
 * Never retried: every fault a second attempt would meet identically (a page shape, a row, the
 * page bound, a 4xx).
 */

/** Double walks per panel read the Web Admin's `.nxpkg` importer asks for. */
export const INVENTORY_READ_ATTEMPTS = 3;
/** The pause before the 2nd and 3rd attempt: time for a moving panel to settle. */
export const INVENTORY_RETRY_DELAYS_MS: readonly number[] = [15_000, 45_000];

/** Whether another double walk could answer differently. Exported for its own test. */
export function inventoryRetryable(outcome: RickpanelInventoryOutcome): boolean {
  if (outcome.ok) return !outcome.complete;
  if (outcome.pagination !== undefined) return false;
  if (outcome.failure === 'TIMEOUT' || outcome.failure === 'UNREACHABLE') return true;
  if (outcome.phase === 'LOGIN') return false;
  if (outcome.failure === 'RATE_LIMITED') return true;
  return outcome.failure === 'PROVIDER_ERROR' && (outcome.status === null || outcome.status >= 500);
}

function diagnosticsOf(
  outcome: RickpanelInventoryOutcome,
  attempts: number,
): LegacyInventoryDiagnostics {
  if (!outcome.ok) {
    return { attempts, walks: [], pagination: outcome.pagination ?? null, status: outcome.status };
  }
  const { first, second } = outcome.evidence;
  return {
    attempts,
    walks: second === null ? [{ ...first }] : [{ ...first }, { ...second }],
    pagination: null,
    status: null,
  };
}

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
    private readonly options: {
      readonly pageSize?: number;
      /** Double walks per read (default one; the Web Admin asks `INVENTORY_READ_ATTEMPTS`). */
      readonly attempts?: number;
      /** A seam for the pause between attempts; the real one waits. */
      readonly sleep?: (ms: number) => Promise<void>;
    } = {},
    private readonly now: () => Date = () => {
      throw new Error('RickpanelInventorySource needs the Clock to stamp a read');
    },
  ) {}

  private sleep(ms: number): Promise<void> {
    if (this.options.sleep !== undefined) return this.options.sleep(ms);
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  requestCounts(): { readonly reads: number; readonly refusedWrites: number } {
    return { ...this.counts };
  }

  pageSize(): number {
    return effectiveInventoryPageSize(this.options.pageSize);
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
    const attempts = Math.max(1, Math.trunc(this.options.attempts ?? 1));
    let outcome: RickpanelInventoryOutcome | undefined;
    let attempt = 0;
    while (attempt < attempts) {
      if (attempt > 0) {
        const delays = INVENTORY_RETRY_DELAYS_MS;
        await this.sleep(delays[Math.min(attempt - 1, delays.length - 1)] ?? 0);
      }
      attempt += 1;
      outcome = await this.reader.listAll({ baseUrl: panel.baseUrl, credentials }, http, {
        ...(this.options.pageSize === undefined ? {} : { pageSize: this.options.pageSize }),
        subscriptionLinks: true,
      });
      if (!inventoryRetryable(outcome)) break;
    }
    if (outcome === undefined) throw new Error('an inventory read made no attempt');
    const diagnostics = diagnosticsOf(outcome, attempt);
    if (!outcome.ok) return { ok: false, failure: outcome.failure, diagnostics };
    if (!outcome.complete) {
      return { ok: true, complete: false, reason: outcome.reason, diagnostics };
    }
    const index = inventoryIndex(panelId, outcome);
    if (index === null) return { ok: true, complete: false, reason: 'NOT_INDEXABLE', diagnostics };
    const states: Record<string, number> = {};
    // The runtime facts P6 adopts from, from the SAME complete walk as the index — never
    // a second read that could describe a different moment. The link is the inventory's
    // opt-in `subscriptionLinks`: `subscriptionFrom` over the same list row, no request
    // of its own. It is held here only to be handed to P6.
    const links = outcome.subscriptionLinks;
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
        subscriptionUrl: links?.get(account.providerUsername) ?? null,
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
      diagnostics,
    };
  }
}
