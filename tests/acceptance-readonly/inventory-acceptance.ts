import { randomBytes } from 'node:crypto';
import type {
  ProviderHttpClient,
  ProviderHttpRequest,
  ProviderHttpResult,
  ProviderTarget,
} from '@nexa/contracts';
import {
  RickpanelInventoryReader,
  USERS_LIST_PATH,
  readOnlyRickpanelHttp,
  type RickpanelInventoryWalk,
} from '../../apps/api/src/modules/platform/providers/infrastructure/rickpanel-inventory';
import {
  TOKEN_PATH,
  USER_PATH,
} from '../../apps/api/src/modules/platform/providers/infrastructure/rickpanel-protocol';

/**
 * Item C1 — the real-RickPanel inventory verification, as one function
 * (`docs/rickpanel-inventory-acceptance.md`).
 *
 * Run against a REAL panel by `pnpm test:acceptance:inventory` (which FAILS without
 * credentials), and against the fake panel by `tests/unit/rickpanel-inventory-acceptance.test.ts`
 * — the latter proves the procedure works mechanically and is NOT evidence about RickPanel.
 *
 * Read-only twice over: the inventory holds only `RickpanelReadOnlyHttp`, and underneath
 * it this file installs a guard that REFUSES, without sending, anything that is not a
 * `GET` or the token exchange — and counts what it refused. A non-zero refusal count fails
 * the run.
 *
 * The report is AGGREGATE ONLY: counts, page shapes, a state histogram. No username, no
 * subscription link, no token, no Telegram id. The known username the operator supplies is
 * used for the lookup and never echoed.
 */

export interface InventoryAcceptanceInput {
  readonly target: ProviderTarget;
  readonly http: ProviderHttpClient;
  /** An account the operator knows is on this panel (any case; it is folded). */
  readonly knownUsername: string;
  readonly pageSize?: number;
  /** How many accounts may appear or disappear between the two walks. */
  readonly driftTolerance?: number;
  /**
   * How many PAIRS of consecutive walks to try before giving up (default 3). A live panel
   * may change between two walks; the procedure then walks a fresh pair rather than
   * calling the first difference a fault — and never calls a differing pair complete.
   * Every attempt's drift is in the report.
   */
  readonly maxAttempts?: number;
}

/** One pair of consecutive walks, as counts. */
export interface InventoryAttempt {
  readonly firstConsistent: boolean;
  readonly secondConsistent: boolean;
  readonly countDrift: number;
  readonly setDrift: number;
}

/** What the guard let through, by kind. Anything but these three is refused. */
export interface InventoryRequestCounts {
  readonly loginExchange: number;
  readonly listPage: number;
  readonly readUser: number;
  readonly otherRead: number;
}

export interface InventoryRunSummary {
  readonly ok: boolean;
  readonly consistent: boolean;
  readonly inconsistentReason: string | null;
  readonly failure: string | null;
  readonly pagination: string | null;
  readonly reportedTotal: number | null;
  readonly rowsFetched: number;
  readonly distinctUsernames: number;
  readonly duplicateRows: number;
  readonly pages: number;
  readonly firstPageRows: number;
  readonly lastPageRows: number;
  readonly states: Readonly<Record<string, number>>;
  readonly usageUnreadable: number;
  readonly providerSpellingDiffers: number;
}

export interface InventoryAcceptanceReport {
  /** The pair the checks judge: the last one walked. */
  readonly first: InventoryRunSummary;
  readonly second: InventoryRunSummary;
  /** Every pair walked, in order; the last is `first`/`second`. */
  readonly attempts: readonly InventoryAttempt[];
  /**
   * What `RickpanelInventoryReader.listAll` — the entry point the matcher actually uses —
   * answered on its own two walks, run after the pair above: `COMPLETE`, its closed
   * incomplete reason, or `FAILED`.
   */
  readonly matcherInventory: string;
  /** Whether `listAll`'s exact username set equals the judged pair's. */
  readonly matcherAgreesWithWalks: boolean;
  /** |second − first| distinct accounts. */
  readonly countDrift: number;
  /** Accounts in exactly one of the two walks. */
  readonly setDrift: number;
  readonly knownLookup: 'FOUND' | 'NOT_FOUND' | 'FAILED';
  /** The known name, by its EXACT provider spelling, is in both walks of the judged pair. */
  readonly knownInInventory: boolean;
  readonly missingLookup: 'FOUND' | 'NOT_FOUND' | 'FAILED';
  /** Requests the guard refused because they were not reads. Must be 0. */
  readonly refusedWrites: number;
  readonly requests: number;
  readonly requestsByKind: InventoryRequestCounts;
  readonly checks: readonly { readonly name: string; readonly pass: boolean }[];
}

/** A client that sends only reads, and counts what it refused. */
export function readGuard(http: ProviderHttpClient): {
  readonly client: ProviderHttpClient;
  readonly refused: () => number;
  readonly sent: () => number;
  readonly byKind: () => InventoryRequestCounts;
} {
  let refused = 0;
  const counts = { loginExchange: 0, listPage: 0, readUser: 0, otherRead: 0 };
  return {
    client: {
      send: async (request: ProviderHttpRequest): Promise<ProviderHttpResult> => {
        const isToken =
          request.method === 'POST' && request.effect === 'READ' && request.path === TOKEN_PATH;
        if (request.method !== 'GET' && !isToken) {
          refused += 1;
          return { ok: false, failure: 'BLOCKED_TARGET', status: null };
        }
        if (isToken) counts.loginExchange += 1;
        else if (request.path.split('?')[0] === USERS_LIST_PATH) counts.listPage += 1;
        else if (request.path.startsWith(`${USER_PATH}/`)) counts.readUser += 1;
        else counts.otherRead += 1;
        return http.send(request);
      },
    },
    refused: () => refused,
    sent: () => counts.loginExchange + counts.listPage + counts.readUser + counts.otherRead,
    byKind: () => ({ ...counts }),
  };
}

export function summarize(outcome: RickpanelInventoryWalk): InventoryRunSummary {
  if (!outcome.ok) {
    return {
      ok: false,
      consistent: false,
      inconsistentReason: null,
      failure: outcome.failure,
      pagination: outcome.pagination ?? null,
      reportedTotal: null,
      rowsFetched: 0,
      distinctUsernames: 0,
      duplicateRows: 0,
      pages: 0,
      firstPageRows: 0,
      lastPageRows: 0,
      states: {},
      usageUnreadable: 0,
      providerSpellingDiffers: 0,
    };
  }
  const states: Record<string, number> = {};
  let usageUnreadable = 0;
  let providerSpellingDiffers = 0;
  if (outcome.consistent) {
    for (const account of outcome.accounts) {
      states[account.state] = (states[account.state] ?? 0) + 1;
      if (account.usage === null) usageUnreadable += 1;
      if (account.providerSpellingDiffers) providerSpellingDiffers += 1;
    }
  }
  return {
    ok: true,
    consistent: outcome.consistent,
    inconsistentReason: outcome.consistent ? null : outcome.reason,
    failure: null,
    pagination: null,
    reportedTotal: outcome.evidence.reportedTotal,
    rowsFetched: outcome.evidence.rowsFetched,
    distinctUsernames: outcome.evidence.distinctUsernames,
    duplicateRows: outcome.evidence.duplicateRows,
    pages: outcome.evidence.pages,
    firstPageRows: outcome.evidence.firstPageRows,
    lastPageRows: outcome.evidence.lastPageRows,
    states,
    usageUnreadable,
    providerSpellingDiffers,
  };
}

function names(outcome: RickpanelInventoryWalk): ReadonlySet<string> {
  return outcome.ok && outcome.consistent
    ? new Set(outcome.accounts.map((a) => a.providerUsername))
    : new Set();
}

function drift(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let n = 0;
  for (const name of a) if (!b.has(name)) n += 1;
  for (const name of b) if (!a.has(name)) n += 1;
  return n;
}

export async function runInventoryAcceptance(
  input: InventoryAcceptanceInput,
): Promise<InventoryAcceptanceReport> {
  const guard = readGuard(input.http);
  const http = readOnlyRickpanelHttp(guard.client);
  const reader = new RickpanelInventoryReader();
  const options = input.pageSize === undefined ? {} : { pageSize: input.pageSize };
  const tolerance = input.driftTolerance ?? 0;
  const maxAttempts = Math.max(1, Math.trunc(input.maxAttempts ?? 3));

  // Pairs of consecutive walks until one pair is identical, or the attempts run out. The
  // checks judge the LAST pair; a pair that differs is never reported as complete.
  const attempts: InventoryAttempt[] = [];
  let firstOutcome!: RickpanelInventoryWalk;
  let secondOutcome!: RickpanelInventoryWalk;
  let setDrift = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    firstOutcome = await reader.walk(input.target, http, options);
    secondOutcome = await reader.walk(input.target, http, options);
    const pairFirst = summarize(firstOutcome);
    const pairSecond = summarize(secondOutcome);
    setDrift = drift(names(firstOutcome), names(secondOutcome));
    attempts.push({
      firstConsistent: pairFirst.ok && pairFirst.consistent,
      secondConsistent: pairSecond.ok && pairSecond.consistent,
      countDrift: Math.abs(pairSecond.distinctUsernames - pairFirst.distinctUsernames),
      setDrift,
    });
    // A transport or shape FAILURE is not drift: walking again would only repeat it.
    if (!pairFirst.ok || !pairSecond.ok) break;
    if (pairFirst.consistent && pairSecond.consistent && setDrift === 0) break;
  }
  const first = summarize(firstOutcome);
  const second = summarize(secondOutcome);
  const a = names(firstOutcome);
  const b = names(secondOutcome);

  // The matcher's own entry point, on its own two walks: what P6 will index from.
  const listed = await reader.listAll(input.target, http, options);
  const matcherInventory = !listed.ok ? 'FAILED' : listed.complete ? 'COMPLETE' : listed.reason;
  const matcherNames =
    listed.ok && listed.complete
      ? new Set(listed.accounts.map((account) => account.providerUsername))
      : new Set<string>();
  const matcherAgreesWithWalks = matcherInventory === 'COMPLETE' && drift(matcherNames, b) === 0;

  // Sent exactly as the operator spelled it (the panel's spelling), and looked for by
  // that exact spelling in both walks — a lowercase match is not the account asked for.
  const knownInInventory = a.has(input.knownUsername) && b.has(input.knownUsername);
  const knownResult = await reader.findAccount(input.target, http, input.knownUsername);
  const knownLookup = !knownResult.ok ? 'FAILED' : knownResult.found ? 'FOUND' : 'NOT_FOUND';
  // A name no panel holds: random, canonical, and long enough never to collide.
  const absent = `nexa-c1-absent-${randomBytes(8).toString('hex')}`;
  const missingResult = await reader.findAccount(input.target, http, absent);
  const missingLookup = !missingResult.ok ? 'FAILED' : missingResult.found ? 'FOUND' : 'NOT_FOUND';

  const countDrift = Math.abs(second.distinctUsernames - first.distinctUsernames);
  const checks = [
    { name: 'first walk consistent', pass: first.ok && first.consistent },
    { name: 'second walk consistent', pass: second.ok && second.consistent },
    {
      name: 'distinct usernames equal the reported total (when reported)',
      pass: first.reportedTotal === null || first.distinctUsernames === first.reportedTotal,
    },
    { name: 'no duplicate rows', pass: first.duplicateRows === 0 && second.duplicateRows === 0 },
    {
      // With a total: every reported row was fetched. Without one: the walk reached the
      // empty page that is its only proof of an end.
      name: 'pagination covered the whole list',
      pass:
        first.ok &&
        (first.reportedTotal === null
          ? first.lastPageRows === 0
          : first.rowsFetched >= first.reportedTotal),
    },
    { name: 'count stable within tolerance', pass: countDrift <= tolerance },
    { name: 'set stable within tolerance', pass: setDrift <= tolerance * 2 },
    {
      // What `listAll` requires before the matcher may use the inventory at all.
      name: 'two consecutive walks identical (indexable)',
      pass: first.ok && first.consistent && second.ok && second.consistent && setDrift === 0,
    },
    {
      name: 'provider total identical on both walks',
      pass: first.ok && second.ok && first.reportedTotal === second.reportedTotal,
    },
    {
      name: "the matcher's listAll reports a complete inventory",
      pass: matcherInventory === 'COMPLETE',
    },
    { name: 'listAll returns exactly the walked set', pass: matcherAgreesWithWalks },
    { name: 'known username found by exact lookup', pass: knownLookup === 'FOUND' },
    { name: 'known username present in both walks by its exact spelling', pass: knownInInventory },
    { name: 'missing username is a clean not-found', pass: missingLookup === 'NOT_FOUND' },
    { name: 'no write was attempted', pass: guard.refused() === 0 },
    {
      name: 'every request sent was the login exchange, a list page or a user read',
      pass: guard.byKind().otherRead === 0,
    },
  ];

  return {
    first,
    second,
    countDrift,
    setDrift,
    attempts,
    matcherInventory,
    matcherAgreesWithWalks,
    knownLookup,
    knownInInventory,
    missingLookup,
    refusedWrites: guard.refused(),
    requests: guard.sent(),
    requestsByKind: guard.byKind(),
    checks,
  };
}
