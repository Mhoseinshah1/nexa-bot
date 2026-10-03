import { randomBytes } from 'node:crypto';
import type {
  ProviderHttpClient,
  ProviderHttpRequest,
  ProviderHttpResult,
  ProviderTarget,
} from '@nexa/contracts';
import {
  RickpanelInventoryReader,
  readOnlyRickpanelHttp,
  type RickpanelInventoryWalk,
} from '../../apps/api/src/modules/platform/providers/infrastructure/rickpanel-inventory';
import { TOKEN_PATH } from '../../apps/api/src/modules/platform/providers/infrastructure/rickpanel-protocol';

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
  readonly first: InventoryRunSummary;
  readonly second: InventoryRunSummary;
  /** |second − first| distinct accounts. */
  readonly countDrift: number;
  /** Accounts in exactly one of the two walks. */
  readonly setDrift: number;
  readonly knownLookup: 'FOUND' | 'NOT_FOUND' | 'FAILED';
  readonly knownInInventory: boolean;
  readonly missingLookup: 'FOUND' | 'NOT_FOUND' | 'FAILED';
  /** Requests the guard refused because they were not reads. Must be 0. */
  readonly refusedWrites: number;
  readonly requests: number;
  readonly checks: readonly { readonly name: string; readonly pass: boolean }[];
}

/** A client that sends only reads, and counts what it refused. */
export function readGuard(http: ProviderHttpClient): {
  readonly client: ProviderHttpClient;
  readonly refused: () => number;
  readonly sent: () => number;
} {
  let refused = 0;
  let sent = 0;
  return {
    client: {
      send: async (request: ProviderHttpRequest): Promise<ProviderHttpResult> => {
        const isRead =
          request.method === 'GET' ||
          (request.method === 'POST' && request.effect === 'READ' && request.path === TOKEN_PATH);
        if (!isRead) {
          refused += 1;
          return { ok: false, failure: 'BLOCKED_TARGET', status: null };
        }
        sent += 1;
        return http.send(request);
      },
    },
    refused: () => refused,
    sent: () => sent,
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

export async function runInventoryAcceptance(
  input: InventoryAcceptanceInput,
): Promise<InventoryAcceptanceReport> {
  const guard = readGuard(input.http);
  const http = readOnlyRickpanelHttp(guard.client);
  const reader = new RickpanelInventoryReader();
  const options = input.pageSize === undefined ? {} : { pageSize: input.pageSize };
  const tolerance = input.driftTolerance ?? 0;

  const firstOutcome = await reader.walk(input.target, http, options);
  const secondOutcome = await reader.walk(input.target, http, options);
  const first = summarize(firstOutcome);
  const second = summarize(secondOutcome);
  const a = names(firstOutcome);
  const b = names(secondOutcome);
  let setDrift = 0;
  for (const n of a) if (!b.has(n)) setDrift += 1;
  for (const n of b) if (!a.has(n)) setDrift += 1;

  // Sent as the operator spelled it (the panel's spelling); compared by its lowercase key.
  const known = input.knownUsername.toLowerCase();
  const knownInInventory =
    firstOutcome.ok &&
    firstOutcome.consistent &&
    firstOutcome.accounts.some((account) => account.username === known);
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
    { name: 'known username found by exact lookup', pass: knownLookup === 'FOUND' },
    { name: 'known username present in the inventory', pass: knownInInventory },
    { name: 'missing username is a clean not-found', pass: missingLookup === 'NOT_FOUND' },
    { name: 'no write was attempted', pass: guard.refused() === 0 },
  ];

  return {
    first,
    second,
    countDrift,
    setDrift,
    knownLookup,
    knownInInventory,
    missingLookup,
    refusedWrites: guard.refused(),
    requests: guard.sent(),
    checks,
  };
}
