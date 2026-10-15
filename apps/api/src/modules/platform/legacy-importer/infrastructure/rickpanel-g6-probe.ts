import type {
  LegacyInventoryWalkDiagnostics,
  ProviderHttpClient,
  ProviderHttpRequest,
  ProviderHttpResult,
  ProviderTarget,
} from '@nexa/contracts';
import {
  INVENTORY_MAX_PAGE_SIZE,
  RickpanelInventoryReader,
  USERS_LIST_PATH,
  createdAtFormat,
  effectiveInventoryPageSize,
  type RickpanelInventoryWalk,
  type RickpanelReadOnlyHttp,
} from '../../providers/infrastructure/rickpanel-inventory.js';
import {
  TOKEN_PATH,
  exchangeRickpanelToken,
  parseJson,
} from '../../providers/infrastructure/rickpanel-protocol.js';
import type { TenantContext } from '@nexa/contracts';
import type { LegacyInventoryLoad } from '../application/ports.js';
import {
  type RickpanelInventorySource,
  sameRelativeOrder,
  walkDiagnosticsView,
} from './rickpanel-inventory-source.js';

/**
 * Gate G6 — a BOUNDED, READ-ONLY probe of a live RickPanel's list
 * (`docs/rickpanel-inventory-acceptance.md` §G6, `docs/rickpanel-inventory.md` §Diagnostics).
 *
 * The per-name resolution rests on four things inferred from Marzban v0.8.4 and never seen on a
 * real RickPanel: the list's shape and `total`, a page-size cap, `created_at` on every row in
 * insertion order, and an order that no offset or limit changes. A live dry run that leaves
 * every needed name unresolved means one of them is false — this probe says which, in numbers,
 * without a dry run and without stopping sales:
 *
 * 1. the list's SHAPE (`{users, total}`), the first page's rows and a learned page cap;
 * 2. `created_at` on a sample page: presence, format classes, inversions;
 * 3. ORDER STABILITY: the same offset fetched twice, and an overlapping page asked with another
 *    `limit` — the rows they share must stand at the same absolute positions;
 * 4. two or three OVERLAPPING WALKS exactly as the dry run walks (the same reader, the same
 *    overlap), each with its full gap-free breakdown (`RickpanelWalkDiagnostics`), whether
 *    neighbouring walks agree on one order, and the churn rate across them.
 *
 * It runs through the caller's `RickpanelReadOnlyHttp` — in production the importer's own
 * protected read session (one login, paced, gated installation-wide) — and adds two HARD caps of
 * its own, checked before every request: list pages and wall time. Hitting either stops the
 * probe with what it has (`stoppedBy`), never a partial answer dressed as a whole one. It sends
 * the token exchange and `GET api/users?offset=&limit=` and nothing else: `readUser` is refused
 * here, and the wire counter below it (`probeWireCounter`) reports every request by kind.
 *
 * The report is numbers and closed codes ONLY — never a name, a row, a `created_at` value, a
 * token or an address.
 */

export const G6_PROBE_VERSION = 1;
/** Defaults: three walks, at most 400 list pages and 20 minutes. */
export const G6_PROBE_DEFAULT_WALKS = 3;
export const G6_PROBE_DEFAULT_MAX_PAGES = 400;
export const G6_PROBE_DEFAULT_MAX_WALL_MS = 20 * 60_000;
/** Hard ceilings no option can exceed. */
export const G6_PROBE_MAX_PAGES_CEILING = 5_000;
export const G6_PROBE_MAX_WALL_MS_CEILING = 90 * 60_000;

/**
 * What the probe can conclude, as closed codes. Each names one way the per-name resolution's
 * assumptions fail on this panel; none of them is a fault of the probe.
 */
export const G6_PROBE_FINDINGS = [
  /** The first page is not `{users: [...], total?: N}`. */
  'NOT_A_PAGE',
  /** No page carries a `total`. */
  'NO_TOTAL',
  /** Some pages carry a `total` and others do not, or it is not a count. */
  'TOTAL_INCONSISTENT',
  /** The panel serves fewer rows than asked, of a longer list (a page cap). */
  'PAGE_CAP',
  /** A row without `created_at` (absent, null or empty). */
  'CREATED_AT_MISSING',
  /** A `created_at` present but not a parseable date string. */
  'CREATED_AT_UNPARSABLE',
  /** A `created_at` that is a number or a string of digits. */
  'CREATED_AT_EPOCH',
  /** A row older than the row before it. */
  'CREATED_AT_OUT_OF_ORDER',
  /** The same offset fetched twice returned the same rows in another order. */
  'ORDER_UNSTABLE_SAME_OFFSET',
  /** An overlapping page asked with another `limit` put a shared row elsewhere. */
  'ORDER_UNSTABLE_OTHER_LIMIT',
  /** The same offset fetched twice returned other rows (the list moved, or the order did). */
  'ROWS_CHANGED_SAME_OFFSET',
  /** The total, or the set of accounts, changed while the probe read. */
  'CHURN',
  /** No walk was gap-free. */
  'NO_GAP_FREE_WALK',
  /** No two consecutive walks agreed on one relative order. */
  'WALKS_ORDER_DIFFERS',
  /** No walk was decisive (gap-free and in one order with a neighbour). */
  'NO_DECISIVE_WALK',
] as const;
export type G6ProbeFinding = (typeof G6_PROBE_FINDINGS)[number];

export type G6ProbeVerdict =
  /** Two consecutive decisive walks, and nothing on the sample contradicts the assumptions. */
  | 'G6_HOLDS'
  /** The probe ran to the end and at least one assumption failed (see `findings`). */
  | 'G6_FAILS'
  /** A request failed or a cap stopped the probe before it could conclude. */
  | 'INCONCLUSIVE';

export interface G6ProbeOptions {
  /** Rows asked per page (clamped to the reader's bounds). */
  readonly pageSize?: number;
  /** Walks to make: 2 or 3. */
  readonly walks?: number;
  /** Hard cap on list pages for the whole probe. */
  readonly maxPages?: number;
  /** Hard cap on the probe's wall time (ms), checked before every request. */
  readonly maxWallMs?: number;
  /** The overlap of each walk's pages (the importer's `walkOverlap(pageSize)`). */
  readonly overlap: number;
}

/** Requests that reached the wire, by kind. Anything but the first two is a defect. */
export interface G6ProbeWire {
  readonly login: number;
  readonly listPage: number;
  readonly other: number;
  /** Refused before sending by the read-only guard. */
  readonly refusedWrites: number;
}

export interface G6ProbeCreatedAt {
  readonly rows: number;
  readonly rowsWithout: number;
  readonly rowsUnparsable: number;
  readonly inversions: number;
  readonly maxInversionMs: number;
  readonly formats: Readonly<Record<string, number>>;
}

export interface G6ProbeReport {
  readonly probe: 'G6';
  readonly version: number;
  readonly verdict: G6ProbeVerdict;
  readonly findings: readonly G6ProbeFinding[];
  readonly shape: {
    readonly listShape: 'USERS_AND_TOTAL' | 'USERS_ONLY' | 'NOT_A_PAGE' | 'NOT_READ';
    readonly pageSizeAsked: number;
    readonly firstPageRows: number;
    readonly learnedLimit: number | null;
  };
  readonly total: {
    readonly pagesWithTotal: number;
    readonly pagesWithoutTotal: number;
    readonly first: number | null;
    readonly last: number | null;
    readonly maxChange: number;
  };
  /** The sample page (offset 0). */
  readonly createdAt: G6ProbeCreatedAt;
  readonly order: {
    readonly sameOffsetTwice: 'IDENTICAL' | 'SAME_ROWS_OTHER_ORDER' | 'DIFFERENT_ROWS' | 'NOT_READ';
    readonly otherLimitOverlap:
      'CONSISTENT' | 'SHIFTED' | 'INCONSISTENT' | 'NOT_TESTABLE' | 'NOT_READ';
  };
  readonly walks: readonly LegacyInventoryWalkDiagnostics[];
  readonly churn: {
    readonly durationMs: number;
    /** (last total − first total) per minute over the probe; null without a total. */
    readonly totalChangePerMinute: number | null;
    /** Accounts (exact spellings) that appeared / disappeared between walks, per minute. */
    readonly addedPerMinute: number;
    readonly removedPerMinute: number;
  };
  readonly budget: {
    readonly maxPages: number;
    readonly maxWallMs: number;
    readonly pagesUsed: number;
    readonly stoppedBy: 'PAGES' | 'WALL_TIME' | null;
  };
  /** The failure that ended the probe early: a closed kind, an HTTP status, a page fault. */
  readonly failure: {
    readonly kind: string;
    readonly status: number | null;
    readonly pagination: string | null;
  } | null;
  /** Requests that reached the panel, by kind. */
  readonly wire: G6ProbeWire;
  /** True only when nothing but the token exchange and list pages was sent or attempted. */
  readonly readOnly: boolean;
  /** What the probe cost the panel (the read session's own counters). */
  readonly load: LegacyInventoryLoad;
}

/** What `runG6Probe` itself concludes; the wire, the load and the read-only check are added by the caller. */
export type G6ProbeResult = Omit<G6ProbeReport, 'probe' | 'version' | 'wire' | 'readOnly' | 'load'>;

/**
 * The probe of one NEXA panel, on the importer's own protected read
 * (`RickpanelInventorySource.withReadSession`): its stored credentials, the installation-wide
 * read gate (it waits behind a dry run's read of the same panel, and a dry run waits behind it),
 * the configured pacing, one login. Null-free failures: `NOT_A_RICKPANEL`, `CREDENTIALS_MISSING`.
 */
export async function probePanelG6(
  source: RickpanelInventorySource,
  scope: TenantContext,
  panelId: string,
  options: Omit<G6ProbeOptions, 'overlap'> & { readonly overlap?: number },
  overlapFor: (pageSize: number) => number,
): Promise<
  | { readonly ok: false; readonly failure: 'NOT_A_RICKPANEL' | 'CREDENTIALS_MISSING' }
  | { readonly ok: true; readonly report: G6ProbeReport }
> {
  const pageSize = effectiveInventoryPageSize(options.pageSize);
  let wire: ReturnType<typeof probeWireCounter> | null = null;
  const outcome = await source.withReadSession(
    scope,
    panelId,
    ({ target, http, now }) =>
      runG6Probe(
        target,
        http,
        { ...options, pageSize, overlap: options.overlap ?? overlapFor(pageSize) },
        now,
      ),
    (client) => {
      wire = probeWireCounter(client);
      return wire.client;
    },
  );
  if (!outcome.ok) return outcome;
  const counted = (wire as ReturnType<typeof probeWireCounter> | null)?.counts() ?? {
    login: 0,
    listPage: 0,
    other: 0,
  };
  const sent: G6ProbeWire = { ...counted, refusedWrites: outcome.refusedWrites };
  const readOnly = sent.other === 0 && sent.refusedWrites === 0;
  return {
    ok: true,
    report: {
      probe: 'G6',
      version: G6_PROBE_VERSION,
      ...outcome.value,
      // A probe that sent anything but reads has not proven anything: never a pass.
      verdict: readOnly ? outcome.value.verdict : 'INCONCLUSIVE',
      wire: sent,
      readOnly,
      load: outcome.load,
    },
  };
}

/**
 * The process exit code for a report: 0 — G6 holds; 1 — G6 fails (the findings say how);
 * 3 — inconclusive (a failure or a cap stopped it); 4 — something but a read was sent or
 * attempted (never expected; a defect). 2 is the CLI's usage error.
 */
export function g6ProbeExitCode(report: G6ProbeReport): number {
  if (!report.readOnly) return 4;
  return report.verdict === 'G6_HOLDS' ? 0 : report.verdict === 'G6_FAILS' ? 1 : 3;
}

/** Thrown by the probe's own caps, before a request is sent. */
class ProbeStop extends Error {
  constructor(readonly by: 'PAGES' | 'WALL_TIME') {
    super(`G6 probe stopped by its ${by} cap`);
  }
}

/**
 * Counts what reaches the wire, by kind (below the read-only guard: only what was sent). The
 * probe's report carries these, and `readOnly` is true only when nothing but the token exchange
 * and list pages went out.
 */
export function probeWireCounter(http: ProviderHttpClient): {
  readonly client: ProviderHttpClient;
  readonly counts: () => Omit<G6ProbeWire, 'refusedWrites'>;
} {
  const counts = { login: 0, listPage: 0, other: 0 };
  return {
    client: {
      send: (request: ProviderHttpRequest): Promise<ProviderHttpResult> => {
        if (request.method === 'POST' && request.path === TOKEN_PATH) counts.login += 1;
        else if (request.method === 'GET' && request.path.split('?')[0] === USERS_LIST_PATH) {
          counts.listPage += 1;
        } else counts.other += 1;
        return http.send(request);
      },
    },
    counts: () => ({ ...counts }),
  };
}

const clampInt = (value: number | undefined, fallback: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.trunc(value ?? fallback)));

function emptyCreatedAt(): G6ProbeCreatedAt {
  return {
    rows: 0,
    rowsWithout: 0,
    rowsUnparsable: 0,
    inversions: 0,
    maxInversionMs: 0,
    formats: {},
  };
}

/** `created_at` of one page, in order: presence, format classes, parse, inversions. */
function createdAtOf(rows: readonly Record<string, unknown>[]): G6ProbeCreatedAt {
  const formats: Record<string, number> = {};
  let rowsWithout = 0;
  let rowsUnparsable = 0;
  let inversions = 0;
  let maxInversionMs = 0;
  let last = -Infinity;
  for (const row of rows) {
    const raw = row['created_at'];
    if (raw === undefined || raw === null || raw === '') {
      rowsWithout += 1;
      continue;
    }
    const format = createdAtFormat(raw);
    formats[format.base] = (formats[format.base] ?? 0) + 1;
    if (format.fractional) formats['FRACTIONAL'] = (formats['FRACTIONAL'] ?? 0) + 1;
    const at = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
    if (Number.isNaN(at)) {
      rowsUnparsable += 1;
      continue;
    }
    if (at < last) {
      inversions += 1;
      maxInversionMs = Math.max(maxInversionMs, last - at);
    } else last = at;
  }
  return { rows: rows.length, rowsWithout, rowsUnparsable, inversions, maxInversionMs, formats };
}

/**
 * Offset 0 asked twice. `IDENTICAL` also when one answer extends the other (a sale appended to a
 * list shorter than a page); `SAME_ROWS_OTHER_ORDER` — the same rows in another order — is an
 * unstable order; `DIFFERENT_ROWS` is the list moving between the requests (informational).
 * Exported for its own test.
 */
export function compareSameOffset(
  a: readonly string[],
  b: readonly string[],
): 'IDENTICAL' | 'SAME_ROWS_OTHER_ORDER' | 'DIFFERENT_ROWS' {
  const n = Math.min(a.length, b.length);
  if (a.slice(0, n).every((id, i) => id === b[i])) return 'IDENTICAL';
  const inB = new Set(b);
  return a.length === b.length && a.every((id) => inB.has(id))
    ? 'SAME_ROWS_OTHER_ORDER'
    : 'DIFFERENT_ROWS';
}

/**
 * The page at offset `k` asked with another limit, against the first page `a`: the rows they
 * share must stand at the same absolute positions (`CONSISTENT`). Shared rows in the same
 * relative order but all moved by one offset are the list moving between the requests (a
 * deletion or insertion ahead of them: `SHIFTED`, informational); any other placement is an
 * order that depends on the limit (`INCONSISTENT`). Exported for its own test.
 */
export function compareOtherLimit(
  a: readonly string[],
  k: number,
  shifted: readonly string[],
): 'CONSISTENT' | 'SHIFTED' | 'INCONSISTENT' | 'NOT_TESTABLE' {
  const at = new Map(a.map((id, i) => [id, i]));
  const moves: number[] = [];
  for (let j = 0; j < shifted.length; j += 1) {
    const i = at.get(shifted[j] as string);
    if (i !== undefined) moves.push(k + j - i);
  }
  if (moves.length < 2) return 'NOT_TESTABLE';
  if (moves.every((m) => m === 0)) return 'CONSISTENT';
  return moves.every((m) => m === moves[0]) ? 'SHIFTED' : 'INCONSISTENT';
}

/** A row's identity, for comparing pages: its name and its raw `created_at`, never reported. */
const idOf = (row: Record<string, unknown>) =>
  `${typeof row['username'] === 'string' ? row['username'] : ''}\u0000${String(row['created_at'] ?? '')}`;

interface ProbePage {
  readonly status: number;
  readonly shape: 'USERS_AND_TOTAL' | 'USERS_ONLY' | 'NOT_A_PAGE';
  readonly rows: readonly Record<string, unknown>[];
  /** The page's `total` (an account count), null when absent, `INVALID` when not a count. */
  readonly accountCount: number | null | 'INVALID';
}

/**
 * The probe. `http` is the read session it runs on (in production: the importer's protected
 * session over the read-only guard); `now` is the read's monotonic clock in ms. Pure apart from
 * the requests it sends through `http`.
 */
export async function runG6Probe(
  target: ProviderTarget,
  http: RickpanelReadOnlyHttp,
  options: G6ProbeOptions,
  now: () => number,
): Promise<G6ProbeResult> {
  const pageSize = effectiveInventoryPageSize(options.pageSize);
  const walkCount = clampInt(options.walks, G6_PROBE_DEFAULT_WALKS, 2, 3);
  const maxPages = clampInt(
    options.maxPages,
    G6_PROBE_DEFAULT_MAX_PAGES,
    1,
    G6_PROBE_MAX_PAGES_CEILING,
  );
  const maxWallMs = clampInt(
    options.maxWallMs,
    G6_PROBE_DEFAULT_MAX_WALL_MS,
    1_000,
    G6_PROBE_MAX_WALL_MS_CEILING,
  );
  const startedAt = now();
  let pagesUsed = 0;
  const check = () => {
    if (now() - startedAt >= maxWallMs) throw new ProbeStop('WALL_TIME');
  };
  // The probe's own caps, above the session: checked before every request is handed to it.
  const capped: RickpanelReadOnlyHttp = Object.freeze<RickpanelReadOnlyHttp>({
    exchangeToken: (form) => {
      check();
      return http.exchangeToken(form);
    },
    listUsersPage: (bearer, offset, limit) => {
      check();
      if (pagesUsed >= maxPages) throw new ProbeStop('PAGES');
      pagesUsed += 1;
      return http.listUsersPage(bearer, offset, limit);
    },
    readUser: () => {
      throw new Error('the G6 probe never reads one user');
    },
  });

  const totals: number[] = [];
  let pagesWithTotal = 0;
  let pagesWithoutTotal = 0;
  let totalInconsistent = false;
  const pageOf = async (
    bearer: string,
    offset: number,
    limit: number,
  ): Promise<ProbePage | ProviderHttpResult> => {
    const answer = await capped.listUsersPage(bearer, offset, limit);
    if (!answer.ok || answer.status < 200 || answer.status >= 300) return answer;
    const body = parseJson(answer.bodyText);
    const users = body?.['users'];
    if (body === null || !Array.isArray(users)) {
      return { status: answer.status, shape: 'NOT_A_PAGE', rows: [], accountCount: null };
    }
    const rows = users.filter(
      (r): r is Record<string, unknown> => typeof r === 'object' && r !== null && !Array.isArray(r),
    );
    const raw = body['total'];
    const total =
      raw === undefined || raw === null
        ? null
        : typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0
          ? raw
          : 'INVALID';
    if (total === null) pagesWithoutTotal += 1;
    else if (total === 'INVALID') totalInconsistent = true;
    else {
      pagesWithTotal += 1;
      totals.push(total);
    }
    return {
      status: answer.status,
      shape: total === null ? 'USERS_ONLY' : 'USERS_AND_TOTAL',
      rows,
      accountCount: total,
    };
  };
  const isPage = (p: ProbePage | ProviderHttpResult): p is ProbePage => 'shape' in p;

  let listShape: G6ProbeReport['shape']['listShape'] = 'NOT_READ';
  let firstPageRows = 0;
  let learnedLimit: number | null = null;
  let createdAt = emptyCreatedAt();
  let sameOffsetTwice: G6ProbeReport['order']['sameOffsetTwice'] = 'NOT_READ';
  let otherLimitOverlap: G6ProbeReport['order']['otherLimitOverlap'] = 'NOT_READ';
  const walks: LegacyInventoryWalkDiagnostics[] = [];
  const walkOrders: (readonly string[])[] = [];
  let added = 0;
  let removed = 0;
  let stoppedBy: 'PAGES' | 'WALL_TIME' | null = null;
  let failure: G6ProbeReport['failure'] = null;
  const failed = (answer: ProviderHttpResult) => {
    failure = {
      kind: answer.ok ? 'HTTP_STATUS' : answer.failure,
      status: answer.ok ? answer.status : (answer.status ?? null),
      pagination: null,
    };
  };

  try {
    const auth = await exchangeRickpanelToken(target, (form) => capped.exchangeToken(form));
    if (!auth.ok) {
      failure = { kind: auth.failure, status: auth.status, pagination: 'LOGIN' };
    } else {
      // 1–2. The first page: shape, total, a cap, created_at on a sample.
      const first = await pageOf(auth.token, 0, pageSize);
      if (!isPage(first)) failed(first);
      else {
        listShape = first.shape;
        firstPageRows = first.rows.length;
        const total = typeof first.accountCount === 'number' ? first.accountCount : null;
        if (first.rows.length < pageSize && total !== null && first.rows.length < total) {
          learnedLimit = first.rows.length;
        }
        createdAt = createdAtOf(first.rows);
        if (first.shape !== 'NOT_A_PAGE') {
          // 3a. The same offset again.
          const again = await pageOf(auth.token, 0, pageSize);
          if (!isPage(again)) failed(again);
          else {
            const a = first.rows.map(idOf);
            const b = again.rows.map(idOf);
            sameOffsetTwice = compareSameOffset(a, b);
            // 3b. An overlapping page asked with ANOTHER limit: shared rows at the same places.
            const k = Math.floor(first.rows.length / 2);
            const otherLimit = Math.max(
              2,
              Math.min(INVENTORY_MAX_PAGE_SIZE, first.rows.length - 1),
            );
            if (first.rows.length < 4) otherLimitOverlap = 'NOT_TESTABLE';
            else {
              const shifted = await pageOf(auth.token, k, otherLimit);
              if (!isPage(shifted)) failed(shifted);
              else otherLimitOverlap = compareOtherLimit(a, k, shifted.rows.map(idOf));
            }
          }
        }
      }
      // 4. Overlapping walks, exactly as the dry run walks.
      if (failure === null && listShape !== 'NOT_A_PAGE') {
        const reader = new RickpanelInventoryReader();
        let previous: ReadonlySet<string> | null = null;
        for (let i = 0; i < walkCount; i += 1) {
          const walk: RickpanelInventoryWalk = await reader.walk(target, capped, {
            pageSize,
            overlap: options.overlap,
            maxPages: G6_PROBE_MAX_PAGES_CEILING,
            clock: now,
          });
          if (!walk.ok) {
            failure = {
              kind: walk.failure,
              status: walk.status,
              pagination: walk.pagination ?? walk.phase ?? null,
            };
            break;
          }
          const order = walk.coverage?.order ?? [];
          const names = new Set(order);
          if (previous !== null) {
            for (const n of names) if (!previous.has(n)) added += 1;
            for (const n of previous) if (!names.has(n)) removed += 1;
          }
          previous = names;
          walkOrders.push(order);
          // The dry run's own per-walk view; `decisive` is decided below, over the neighbours.
          const view = walkDiagnosticsView(
            walk,
            false,
            walkOrders.length > 1
              ? sameRelativeOrder(walkOrders[walkOrders.length - 2], order)
              : null,
          );
          if (view !== null) walks.push(view);
          const d = walk.coverage?.diagnostics;
          if (d !== undefined) {
            if (d.reportedTotalFirst !== null) totals.push(d.reportedTotalFirst);
            if (d.reportedTotalLast !== null) totals.push(d.reportedTotalLast);
          }
          // Keep at most two walks' orders: memory stays O(rows), not O(walks × rows).
          if (walkOrders.length > 2) walkOrders.shift();
        }
      }
    }
  } catch (error) {
    if (!(error instanceof ProbeStop)) throw error;
    stoppedBy = error.by;
  }

  // Decisive: gap-free and in one relative order with a NEIGHBOUR (before or after).
  const decisiveWalks = walks.map(
    (w, i) =>
      w.gapFree && (w.sameOrderAsPrevious === true || walks[i + 1]?.sameOrderAsPrevious === true),
  );
  const finalWalks = walks.map((w, i) => ({ ...w, decisive: decisiveWalks[i] ?? false }));
  const durationMs = Math.max(0, now() - startedAt);
  const minutes = durationMs / 60_000;
  const perMinute = (n: number) => (minutes > 0 ? Math.round((n / minutes) * 100) / 100 : 0);
  const firstTotal = totals[0] ?? null;
  const lastTotal = totals.length > 0 ? (totals[totals.length - 1] ?? null) : null;
  const maxChange =
    firstTotal === null ? 0 : totals.reduce((m, x) => Math.max(m, Math.abs(x - firstTotal)), 0);

  const findings = new Set<G6ProbeFinding>();
  if (listShape === 'NOT_A_PAGE') findings.add('NOT_A_PAGE');
  if (listShape !== 'NOT_READ' && listShape !== 'NOT_A_PAGE') {
    if (pagesWithTotal === 0) findings.add('NO_TOTAL');
    else if (pagesWithoutTotal > 0 || totalInconsistent) findings.add('TOTAL_INCONSISTENT');
  }
  if (totalInconsistent) findings.add('TOTAL_INCONSISTENT');
  if (learnedLimit !== null || finalWalks.some((w) => w.learnedLimit !== null))
    findings.add('PAGE_CAP');
  const anyWalk = (f: (w: LegacyInventoryWalkDiagnostics) => boolean) => finalWalks.some(f);
  if (createdAt.rowsWithout > 0 || anyWalk((w) => w.createdAt.rowsWithout > 0)) {
    findings.add('CREATED_AT_MISSING');
  }
  if (createdAt.rowsUnparsable > 0 || anyWalk((w) => w.createdAt.rowsUnparsable > 0)) {
    findings.add('CREATED_AT_UNPARSABLE');
  }
  if (
    (createdAt.formats['EPOCH_LIKE'] ?? 0) > 0 ||
    anyWalk((w) => w.createdAt.formats.some((f) => f.code === 'EPOCH_LIKE'))
  ) {
    findings.add('CREATED_AT_EPOCH');
  }
  if (createdAt.inversions > 0 || anyWalk((w) => w.createdAt.inversions > 0)) {
    findings.add('CREATED_AT_OUT_OF_ORDER');
  }
  if (sameOffsetTwice === 'SAME_ROWS_OTHER_ORDER') findings.add('ORDER_UNSTABLE_SAME_OFFSET');
  if (sameOffsetTwice === 'DIFFERENT_ROWS') findings.add('ROWS_CHANGED_SAME_OFFSET');
  if (otherLimitOverlap === 'INCONSISTENT') findings.add('ORDER_UNSTABLE_OTHER_LIMIT');
  if (maxChange > 0 || added > 0 || removed > 0) findings.add('CHURN');
  if (finalWalks.length > 0) {
    if (!finalWalks.some((w) => w.gapFree)) findings.add('NO_GAP_FREE_WALK');
    if (finalWalks.length > 1 && !finalWalks.slice(1).some((w) => w.sameOrderAsPrevious === true)) {
      findings.add('WALKS_ORDER_DIFFERS');
    }
    if (!finalWalks.some((w) => w.decisive)) findings.add('NO_DECISIVE_WALK');
  }
  // G6 holds when the walks would SETTLE a dry run: a decisive walk with a later one (a decision
  // walk), and the last walk decisive too — the dry run's own rule — and nothing on the way
  // contradicts an assumption. Churn alone is not a failure: selling is normal.
  const last = finalWalks.length - 1;
  const settles =
    last > 0 &&
    (finalWalks[last]?.decisive ?? false) &&
    finalWalks.slice(0, last).some((w) => w.decisive);
  // A list that is not a page is a conclusion too: the shape differs from the inference.
  const concluded =
    failure === null &&
    stoppedBy === null &&
    (finalWalks.length === walkCount || listShape === 'NOT_A_PAGE');
  // Selling, a page cap and rows that moved between two requests are what a live panel does.
  const informational = new Set<G6ProbeFinding>(['CHURN', 'PAGE_CAP', 'ROWS_CHANGED_SAME_OFFSET']);
  const blocking = [...findings].filter((f) => !informational.has(f));
  const verdict: G6ProbeVerdict = !concluded
    ? 'INCONCLUSIVE'
    : settles && blocking.length === 0
      ? 'G6_HOLDS'
      : 'G6_FAILS';
  return {
    verdict,
    findings: G6_PROBE_FINDINGS.filter((f) => findings.has(f)),
    shape: { listShape, pageSizeAsked: pageSize, firstPageRows, learnedLimit },
    total: { pagesWithTotal, pagesWithoutTotal, first: firstTotal, last: lastTotal, maxChange },
    createdAt,
    order: { sameOffsetTwice, otherLimitOverlap },
    walks: finalWalks,
    churn: {
      durationMs,
      totalChangePerMinute:
        firstTotal === null || lastTotal === null ? null : perMinute(lastTotal - firstTotal),
      addedPerMinute: perMinute(added),
      removedPerMinute: perMinute(removed),
    },
    budget: { maxPages, maxWallMs, pagesUsed, stoppedBy },
    failure,
  };
}
