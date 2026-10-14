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
  LegacyInventoryLoad,
  LegacyInventoryPort,
  LegacyInventoryRead,
} from '../application/ports.js';
import { PROCESS_PANEL_READ_GATE, panelReadKey, type PanelReadGate } from './panel-read-gate.js';
import {
  DEFAULT_PANEL_READ_POLICY,
  INVENTORY_REQUEST_INTERVAL_MS,
  abortableSleep,
  emptyPanelReadCounters,
  protectedReadSession,
  type PanelReadPolicy,
  type ReadClock,
  type ReadWaitKind,
} from './rickpanel-read-session.js';

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
 * ## Load on the panel (owner requirement, PR #281)
 *
 * Every read — the Web Admin's, the CLI's, the rehearsal walk's — goes through
 * `protectedReadSession` under a `PanelReadGate`:
 *
 * - ONE read of a panel at a time in the whole installation (the gate, keyed by the panel's
 *   origin), and inside it ONE request in flight, at least `requestIntervalMs` apart
 *   (default `INVENTORY_REQUEST_INTERVAL_MS`, 1 s), longer after a slow answer;
 * - ONE login per read: every walk and attempt of the read reuses it; a 401 mid-read buys one
 *   fresh login; a refused login is never asked again;
 * - a 429 waits the panel's `Retry-After`, a timeout, an unreachable panel or a 5xx waits a
 *   bounded backoff — all drawing on ONE retry budget per read; a 4xx, a page-shape fault or
 *   an oversized answer is final;
 * - the step's signal (a lost lease, a cancelled job) ends the read before its next request
 *   and ends every wait — for the gate, the pacing, a backoff, the pause between attempts.
 *
 * None of it touches what the read DECIDES: complete still means two consecutive walks, each
 * consistent with the panel's total, with identical exact username sets.
 *
 * ## Attempts (DRY_RUN_MISMATCH)
 *
 * Opt-in (`attempts`; the Web Admin's `.nxpkg` importer asks for `INVENTORY_READ_ATTEMPTS`;
 * every other caller — the CLI, the rehearsal walk — reads once, as before). A live panel that
 * moved during a walk is read again, up to `attempts` double walks, with a pause before each,
 * still inside the same gate and on the same login. The criterion is NOT relaxed by it: every
 * attempt is a full `listAll`, and only an attempt that is complete on its own is ever indexed.
 *
 * Only an INCOMPLETE answer (`TOTAL_CHANGED`, `COUNT_MISMATCH`, `WALKS_DIFFER`) starts another
 * attempt. A transport failure, a 429 or a 5xx was already retried, within the read's one
 * budget, by the session; a read that still failed is not walked again from the start —
 * that is how retries would multiply into a storm on a panel that is already struggling.
 */

/** Double walks per panel read the Web Admin's `.nxpkg` importer asks for. */
export const INVENTORY_READ_ATTEMPTS = 3;
/** The pause before the 2nd and 3rd attempt: time for a moving panel to settle. */
export const INVENTORY_RETRY_DELAYS_MS: readonly number[] = [15_000, 45_000];

/**
 * Whether another double walk could answer differently: only an incomplete answer (the panel
 * moved). Failures were retried, boundedly, by the read session. Exported for its own test.
 */
export function inventoryRetryable(outcome: RickpanelInventoryOutcome): boolean {
  return outcome.ok && !outcome.complete;
}

function diagnosticsOf(
  outcome: RickpanelInventoryOutcome,
  attempts: number,
  load: LegacyInventoryLoad,
): LegacyInventoryDiagnostics {
  if (!outcome.ok) {
    return {
      attempts,
      walks: [],
      pagination: outcome.pagination ?? null,
      status: outcome.status,
      load,
    };
  }
  const { first, second } = outcome.evidence;
  return {
    attempts,
    walks: second === null ? [{ ...first }] : [{ ...first }, { ...second }],
    pagination: null,
    status: null,
    load,
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
      /**
       * A seam for every wait of a read — the pause between attempts, the pacing, a backoff,
       * a `Retry-After`, the gate's queue (`kind` says which); the real one waits. A test that
       * gives it must also give `clock` if it wants the waits to move time.
       */
      readonly sleep?: (ms: number, signal?: AbortSignal, kind?: ReadWaitKind) => Promise<void>;
      /** A seam for the read's monotonic time (ms); `Date.now` by default. */
      readonly clock?: () => number;
      /**
       * The executor step's signal (its lease). Checked before every request, and every wait
       * ends on it: a worker that lost its lease stops HERE, inside the importer's `prepare`
       * — before any write — instead of waking up to read and plan again.
       */
      readonly signal?: AbortSignal;
      /** At least this long between two requests to one panel (`INVENTORY_REQUEST_INTERVAL_MS`). */
      readonly requestIntervalMs?: number;
      /** The rest of the read's load policy (retry budget, token refreshes, `Retry-After` cap). */
      readonly policy?: Partial<Omit<PanelReadPolicy, 'requestIntervalMs'>>;
      /** Orders the reads of one panel; the process-local gate unless the container gives one. */
      readonly gate?: PanelReadGate;
    } = {},
    private readonly now: () => Date = () => {
      throw new Error('RickpanelInventorySource needs the Clock to stamp a read');
    },
  ) {}

  private readonly clock: ReadClock = {
    now: () => (this.options.clock ?? Date.now)(),
    sleep: (ms, signal, kind) =>
      this.options.sleep === undefined
        ? abortableSleep(ms, signal)
        : this.options.sleep(ms, signal, kind),
  };

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
    const signal = this.options.signal;
    const gate = this.options.gate ?? PROCESS_PANEL_READ_GATE;
    // One read of this panel at a time, installation-wide: wait our turn (abortably).
    const queuedAt = this.clock.now();
    const lease = await gate.acquire(panelReadKey(panel.baseUrl), signal);
    const startedAt = this.clock.now();
    try {
      const counters = emptyPanelReadCounters();
      const http = protectedReadSession(
        readOnlyRickpanelHttp(readOnlyGuard(this.access.http(panel.baseUrl), this.counts)),
        {
          policy: {
            ...DEFAULT_PANEL_READ_POLICY,
            ...this.options.policy,
            requestIntervalMs: Math.max(
              0,
              Math.trunc(this.options.requestIntervalMs ?? INVENTORY_REQUEST_INTERVAL_MS),
            ),
          },
          clock: this.clock,
          counters,
          ...(signal === undefined ? {} : { signal }),
          leaseLost: () => lease.isLost(),
        },
      );
      const attempts = Math.max(1, Math.trunc(this.options.attempts ?? 1));
      let outcome: RickpanelInventoryOutcome | undefined;
      let attempt = 0;
      while (attempt < attempts) {
        if (attempt > 0) {
          const delays = INVENTORY_RETRY_DELAYS_MS;
          const pause = delays[Math.min(attempt - 1, delays.length - 1)] ?? 0;
          await this.clock.sleep(pause, signal, 'attempt');
        }
        // A lost lease ends the read before another attempt, never after it.
        signal?.throwIfAborted();
        attempt += 1;
        outcome = await this.reader.listAll({ baseUrl: panel.baseUrl, credentials }, http, {
          ...(this.options.pageSize === undefined ? {} : { pageSize: this.options.pageSize }),
          subscriptionLinks: true,
        });
        if (!inventoryRetryable(outcome)) break;
      }
      if (outcome === undefined) throw new Error('an inventory read made no attempt');
      return this.finish(panelId, outcome, attempt, {
        ...counters,
        pageSize: this.pageSize(),
        lockWaitMs: Math.max(0, startedAt - queuedAt),
        durationMs: Math.max(0, this.clock.now() - startedAt),
      });
    } finally {
      await lease.release();
    }
  }

  private finish(
    panelId: string,
    outcome: RickpanelInventoryOutcome,
    attempt: number,
    load: LegacyInventoryLoad,
  ): LegacyInventoryRead {
    const diagnostics = diagnosticsOf(outcome, attempt, load);
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
