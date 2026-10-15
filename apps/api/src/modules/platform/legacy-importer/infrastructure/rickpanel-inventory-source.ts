import type {
  ProviderHttpClient,
  ProviderHttpRequest,
  ProviderHttpResult,
  ProviderTarget,
  TenantContext,
} from '@nexa/contracts';
import { toProviderCredentials } from '../../panels/application/probe-core.js';
import {
  RickpanelInventoryReader,
  effectiveInventoryPageSize,
  inventoryIndex,
  readOnlyRickpanelHttp,
  type RickpanelInventoryAccount,
  type RickpanelInventoryOutcome,
  type RickpanelInventoryWalk,
  type RickpanelReadOnlyHttp,
} from '../../providers/infrastructure/rickpanel-inventory.js';
import { TOKEN_PATH } from '../../providers/infrastructure/rickpanel-protocol.js';
import type {
  AccountRuntime,
  LegacyInventoryDiagnostics,
  LegacyInventoryLoad,
  LegacyInventoryPort,
  LegacyInventoryRead,
  LegacyInventoryReadOptions,
} from '../application/ports.js';
import {
  decideNeededNames,
  resolutionCounts,
  type NameResolution,
} from '../application/inventory-resolution.js';
import type { PanelInventoryIndex } from '../../legacy-import/application/legacy-service-matching.js';
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

/**
 * Rows each page of a per-name resolution's walk repeats from the previous one: how many rows
 * may be deleted ahead of the cursor between two page requests (one interval apart) before a
 * boundary stops being chained. Ten at the default page size of 100 (10% more pages).
 */
export const INVENTORY_WALK_OVERLAP = 10;

export function walkOverlap(pageSize: number): number {
  return Math.max(1, Math.min(INVENTORY_WALK_OVERLAP, Math.floor(pageSize / 4)));
}

/** True when the rows common to both orders come in the same relative order in each. */
export function sameRelativeOrder(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean {
  if (a === undefined || b === undefined) return false;
  const inB = new Set(b);
  const inA = new Set(a);
  const commonA = a.filter((n) => inB.has(n));
  const commonB = b.filter((n) => inA.has(n));
  return commonA.length === commonB.length && commonA.every((n, i) => n === commonB[i]);
}

/**
 * Walks one per-name resolution may make: two, and one more when they do not settle every name
 * (a walk broken by a burst of deletions or a missed insertion; a decision walk with no gap-free
 * walk after it). Each is a full paced walk.
 */
export const TARGETED_MAX_WALKS = 3;

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
      /**
       * Per-name resolution (the Web Admin's `.nxpkg` importer only): when the importer names
       * the usernames the backup needs and the panel is not one complete snapshot, decide
       * those names one by one instead of leaving the whole panel undecided. Absent (the CLI,
       * the rehearsal walk): the read is exactly as before.
       */
      readonly targeted?: boolean;
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

  async read(
    scope: TenantContext,
    panelId: string,
    readOptions: LegacyInventoryReadOptions = {},
  ): Promise<LegacyInventoryRead> {
    const panel = await this.access.panel(scope, panelId);
    if (panel === null || panel.providerType !== 'rickpanel') {
      return { ok: false, failure: 'NOT_A_RICKPANEL' };
    }
    // A panel the backup asks nothing of is not read at all: no credential, no read gate, no
    // request — so a missing credential or another job's long read cannot make it matter.
    if (this.options.targeted === true && readOptions.needed?.size === 0) {
      return this.nothingNeeded(panelId);
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
      const load = (): LegacyInventoryLoad => ({
        ...counters,
        pageSize: this.pageSize(),
        lockWaitMs: Math.max(0, startedAt - queuedAt),
        durationMs: Math.max(0, this.clock.now() - startedAt),
      });
      const needed = readOptions.needed;
      if (this.options.targeted === true && needed !== undefined) {
        return await this.readTargeted(
          panelId,
          { baseUrl: panel.baseUrl, credentials },
          http,
          needed,
          load,
        );
      }
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
      return this.finish(panelId, outcome, attempt, load());
    } finally {
      await lease.release();
    }
  }

  /**
   * The per-name resolution (`inventory-resolution.ts`). Two walks at least, with overlapping
   * pages — a first walk the panel moved under does not end the read. If the two are one
   * complete snapshot (the same rows, same creation times), the read is the complete read it
   * always was, as of the first walk's end. Otherwise each needed name is decided from the
   * walks, as of a gap-free DECISION walk's end, a spelling present only when a later walk
   * returned the same row; until that settles every name and the last walk is gap-free, the
   * panel is walked again, at most `TARGETED_MAX_WALKS` walks in all. No exact lookup is sent.
   */
  private async readTargeted(
    panelId: string,
    target: ProviderTarget,
    http: RickpanelReadOnlyHttp,
    needed: ReadonlyMap<string, string | null>,
    load: () => LegacyInventoryLoad,
  ): Promise<LegacyInventoryRead> {
    const signal = this.options.signal;
    const walkOptions = {
      ...(this.options.pageSize === undefined ? {} : { pageSize: this.options.pageSize }),
      subscriptionLinks: true,
      overlap: walkOverlap(this.pageSize()),
    };
    signal?.throwIfAborted();
    // When each walk ended: a decision's runtime facts are stamped with its own walk's end.
    const endedAt: Date[] = [];
    const first = await this.reader.walk(target, http, walkOptions);
    if (!first.ok) return this.finish(panelId, first, 1, load());
    endedAt.push(this.now());
    signal?.throwIfAborted();
    const second = await this.reader.walk(target, http, walkOptions);
    if (!second.ok) return this.finish(panelId, second, 1, load());
    endedAt.push(this.now());

    // One complete snapshot after all: the complete read it always was (the listAll rule), as
    // of the FIRST walk's end — the second, returning every row of it unchanged (same name and
    // creation time), is what proves each survived that moment. The second's own end proves
    // nothing: a row it read may be deleted before it ends, unseen.
    if (first.consistent && second.consistent) {
      const a = first.accounts.map((x) => x.providerUsername);
      const b = new Set(second.accounts.map((x) => x.providerUsername));
      const sameRows = a.every(
        (name) =>
          b.has(name) &&
          first.coverage?.createdAt.get(name) === second.coverage?.createdAt.get(name),
      );
      if (a.length === b.size && sameRows) {
        return this.finish(
          panelId,
          {
            ok: true,
            complete: true,
            accounts: first.accounts,
            evidence: { first: first.evidence, second: second.evidence },
            ...(first.subscriptionLinks === undefined
              ? {}
              : { subscriptionLinks: first.subscriptionLinks }),
          },
          1,
          load(),
          endedAt[0],
        );
      }
    }

    const walks: Extract<RickpanelInventoryWalk, { ok: true }>[] = [first, second];
    // FEWER distinct names than a total that held still: the list withholds rows. (More names
    // than the total is churn — a row read, then deleted, while a sale was appended — which
    // the gap-free proof already accounts for.)
    const countMismatch = (w: Extract<RickpanelInventoryWalk, { ok: true }>) =>
      !w.consistent &&
      w.reason === 'COUNT_MISMATCH' &&
      w.evidence.reportedTotal !== null &&
      w.evidence.distinctUsernames < w.evidence.reportedTotal;
    const seen = walks.map((w) => (w.consistent ? w.accounts : w.observed));
    // A walk decisions may rest on: gap-free, and in one relative order with a neighbouring walk
    // (an unordered list would make chaining a coincidence).
    const decisive = (i: number) =>
      walks[i]?.coverage?.gapFree === true &&
      ((i > 0 && sameRelativeOrder(walks[i - 1]?.coverage?.order, walks[i]?.coverage?.order)) ||
        (i + 1 < walks.length &&
          sameRelativeOrder(walks[i]?.coverage?.order, walks[i + 1]?.coverage?.order)));
    const resolutionWalks = () =>
      walks.map((w, i) => ({
        accounts: seen[i] ?? [],
        createdAt: w.coverage?.createdAt ?? new Map<string, string>(),
        decisive: decisive(i),
      }));
    // Unresolved for want of evidence (a name the backup spells two ways never resolves).
    const undecided = (resolved: ReadonlyMap<string, NameResolution>) => {
      let count = 0;
      for (const [name, r] of resolved)
        if (r.kind === 'UNRESOLVED' && needed.get(name) !== null) count += 1;
      return count;
    };
    // The decision walk: a decisive walk with a later one to confirm it, leaving the fewest
    // names undecided (the latest on a tie); settled when it leaves none.
    const decision = () => {
      const rw = resolutionWalks();
      let best: { index: number; resolved: Map<string, NameResolution>; left: number } | null =
        null;
      for (let i = 0; i < walks.length - 1; i += 1) {
        if (!(rw[i]?.decisive ?? false)) continue;
        const resolved = decideNeededNames(needed, rw, i);
        const left = undecided(resolved);
        if (best === null || left <= best.left) best = { index: i, resolved, left };
      }
      return best;
    };
    // Settled: the decision walk leaves no name undecided, and the LAST walk is gap-free too —
    // so every spelling that still exists as the read ends was seen, and counts toward a
    // collision (a case variant created after the decision walk is not left unseen).
    const settled = () =>
      walks[walks.length - 1]?.coverage?.gapFree === true && decision()?.left === 0;
    while (!settled() && walks.length < TARGETED_MAX_WALKS && !walks.some(countMismatch)) {
      signal?.throwIfAborted();
      const next = await this.reader.walk(target, http, walkOptions);
      if (!next.ok) return this.finish(panelId, next, 1, load());
      endedAt.push(this.now());
      walks.push(next);
      seen.push(next.consistent ? next.accounts : next.observed);
    }
    const evidence = { first: first.evidence, second: second.evidence };
    // A walk whose total held still yet whose rows do not add up to it is not churn: the list
    // systematically withholds rows, and a withheld row may be the case variant that makes a
    // name a collision. That panel stays incomplete, exactly as before.
    if (walks.some(countMismatch)) {
      return this.finish(
        panelId,
        { ok: true, complete: false, reason: 'COUNT_MISMATCH', evidence },
        1,
        load(),
      );
    }
    const reason = !first.consistent
      ? first.reason
      : !second.consistent
        ? second.reason
        : 'WALKS_DIFFER';
    // Every decision and runtime fact is the DECISION walk's, stamped when it ended. With no
    // decision walk, the last one is reported and every name is unresolved.
    const chosen = decision();
    const gapFree = chosen !== null;
    const at = chosen?.index ?? walks.length - 1;
    const observedAt = endedAt[at] ?? this.now();
    const last = walks[at] as Extract<RickpanelInventoryWalk, { ok: true }>;
    const lastSeen = seen[at] as readonly RickpanelInventoryAccount[];
    const resolved = chosen?.resolved ?? decideNeededNames(needed, resolutionWalks(), null);

    const bySpelling = new Map(lastSeen.map((a) => [a.providerUsername, a]));
    const links = last.subscriptionLinks;
    const runtime = new Map<string, AccountRuntime>();
    const usernames = new Map<string, readonly string[]>();
    const covered = new Set<string>();
    for (const [name, r] of resolved) {
      if (r.kind === 'UNRESOLVED') continue;
      if (r.kind === 'PRESENT') {
        const account = bySpelling.get(r.spelling);
        if (account === undefined) continue; // never: a present spelling is the decision walk's
        runtime.set(r.spelling, {
          state: account.state,
          usage:
            account.usage === null
              ? null
              : {
                  usedBytes: account.usage.usedBytes,
                  totalBytes: account.usage.totalBytes,
                  expiresAt: account.usage.expiresAt,
                },
          subscriptionUrl: links?.get(r.spelling) ?? null,
        });
        usernames.set(name, [r.spelling]);
      } else if (r.kind === 'COLLISION') {
        usernames.set(name, r.spellings);
      }
      covered.add(name);
    }
    const states: Record<string, number> = {};
    for (const account of lastSeen) states[account.state] = (states[account.state] ?? 0) + 1;
    return {
      ok: true,
      complete: true,
      index: { panelId, usernames, covered },
      accounts: lastSeen.length,
      states,
      runtime,
      observedAt,
      resolution: {
        mode: 'TARGETED',
        reason,
        needed: needed.size,
        ...resolutionCounts(resolved),
        walks: walks.length,
        gapFree,
      },
      diagnostics: {
        attempts: 1,
        walks: walks.map((w) => ({ ...w.evidence })),
        pagination: null,
        status: null,
        load: load(),
      },
    };
  }

  /** The read of a panel the backup names nothing on: decided without a request. */
  private nothingNeeded(panelId: string): LegacyInventoryRead {
    const index: PanelInventoryIndex = { panelId, usernames: new Map(), covered: new Set() };
    return {
      ok: true,
      complete: true,
      index,
      accounts: 0,
      states: {},
      runtime: new Map(),
      observedAt: this.now(),
      resolution: {
        mode: 'TARGETED',
        reason: 'NOTHING_NEEDED',
        needed: 0,
        present: 0,
        absent: 0,
        collisions: 0,
        unresolved: 0,
        walks: 0,
        gapFree: false,
      },
      diagnostics: {
        attempts: 0,
        walks: [],
        pagination: null,
        status: null,
        load: {
          ...emptyPanelReadCounters(),
          pageSize: this.pageSize(),
          lockWaitMs: 0,
          durationMs: 0,
        },
      },
    };
  }

  private finish(
    panelId: string,
    outcome: RickpanelInventoryOutcome,
    attempt: number,
    load: LegacyInventoryLoad,
    observedAt?: Date,
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
      observedAt: observedAt ?? this.now(),
      diagnostics,
    };
  }
}
