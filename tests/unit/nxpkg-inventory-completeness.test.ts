import { describe, expect, it } from 'vitest';
import {
  legacyMigrationDryRunInventoryIncomplete,
  money,
  type LegacyMigrationDryRunReport,
  type ProviderHttpClient,
  type ProviderHttpRequest,
  type ProviderHttpResult,
} from '@nexa/contracts';
import { parsePanelMapping } from '../../apps/api/src/modules/platform/legacy-importer/application/panel-mapping';
import {
  PLAN_DIGEST_FORMAT_OUTDATED,
  planLegacyImport,
  planTalliesDigest,
  planTalliesDigestV1,
  planTalliesRefusalCounts,
  servicesDecisionDigest,
} from '../../apps/api/src/modules/platform/legacy-importer/application/plan';
import type { LegacyInventoryRead } from '../../apps/api/src/modules/platform/legacy-importer/application/ports';
import type { ServiceReviewInputs } from '../../apps/api/src/modules/platform/legacy-importer/application/plan';
import { readFromSession } from '../../apps/api/src/modules/platform/legacy-importer/application/source-snapshot';
import { FixtureLegacySourceConnector } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/fixture-legacy-source';
import {
  INVENTORY_READ_ATTEMPTS,
  INVENTORY_RETRY_DELAYS_MS,
  RickpanelInventorySource,
  inventoryRetryable,
} from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/rickpanel-inventory-source';
import {
  NxpkgMigrationAdapters,
  dryRunReportOf,
  mismatchCounts,
  providerIncompleteReasons,
} from '../../apps/api/src/modules/platform/legacy-migration/infrastructure/nxpkg-migration-adapters';
import { SERVICE_CANDIDATE_CATEGORIES } from '../../apps/api/src/modules/platform/legacy-importer/application/decisions';
import { LegacyMigrationStepFailure } from '../../apps/api/src/modules/platform/legacy-migration/application/ports';
import { InProcessPanelReadGate } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/panel-read-gate';
import {
  DEFAULT_PANEL_READ_POLICY,
  INVENTORY_BACKOFF_MS,
} from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/rickpanel-read-session';
import { buildSyntheticLegacyDataset } from '../fixtures/legacy/synthetic-legacy';
import { syntheticInventories, syntheticMappingFile } from '../fixtures/legacy/synthetic-support';

/**
 * DRY_RUN_MISMATCH, fixed at the root: a production-like Mirza import plans only on a COMPLETE
 * live RickPanel inventory, at the dry run AND at the apply, and binds what that read decided
 * per invoice. SYNTHETIC data and an in-memory panel only — no socket, no real panel.
 */

// --- an in-memory RickPanel list (read-only by the client's own guard) ---------------------------

interface Panel {
  names: string[];
  login: 'ok' | 'refused' | 'rate-limited';
  tokenExchanges: number;
  listCalls: number;
  requests: ProviderHttpRequest[];
  /** Before each list page: may change `names`, or answer in the panel's place. */
  beforePage: (walk: number, offset: number) => ProviderHttpResult | undefined;
  /** Serves page rows; the default is the documented, stable order. */
  rows: (names: readonly string[], offset: number, limit: number) => string[];
}

const answer = (status: number, body: unknown): ProviderHttpResult => ({
  ok: true,
  status,
  headers: {},
  bodyText: JSON.stringify(body),
  setCookie: [],
});

function panelOf(names: readonly string[]): Panel {
  return {
    names: [...names],
    login: 'ok',
    tokenExchanges: 0,
    listCalls: 0,
    requests: [],
    beforePage: () => undefined,
    rows: (all, offset, limit) => all.slice(offset, offset + limit),
  };
}

function clientOf(panel: Panel): ProviderHttpClient {
  return {
    send: async (request) => {
      panel.requests.push(request);
      if (request.method === 'POST') {
        panel.tokenExchanges += 1;
        if (panel.login === 'rate-limited') return answer(429, { detail: 'too many logins' });
        return panel.login === 'ok'
          ? answer(200, { access_token: 'token' })
          : answer(401, { detail: 'Incorrect username or password' });
      }
      const query = new URLSearchParams(request.path.split('?')[1] ?? '');
      const offset = Number(query.get('offset'));
      const limit = Number(query.get('limit'));
      panel.listCalls += 1;
      const instead = panel.beforePage(panel.tokenExchanges, offset);
      if (instead !== undefined) return instead;
      const users = panel
        .rows(panel.names, offset, limit)
        .map((username) => ({ username, status: 'active' }));
      return answer(200, { users, total: panel.names.length });
    },
  };
}

function sourceFor(panel: Panel, options: Record<string, unknown> = {}) {
  /** The pauses BETWEEN attempts (the walk again after an incomplete answer). */
  const sleeps: number[] = [];
  /** Every wait of the read, by kind: pacing, backoff, Retry-After, attempt, gate. */
  const waits: { ms: number; kind: string | undefined }[] = [];
  let now = 0;
  const source = new RickpanelInventorySource(
    {
      panel: async () => ({ baseUrl: 'https://panel.invalid', providerType: 'rickpanel' }),
      credentials: async () => ({ username: 'admin', password: 'synthetic', apiToken: null }),
      http: () => clientOf(panel),
    },
    {
      pageSize: 2,
      attempts: INVENTORY_READ_ATTEMPTS,
      clock: () => now,
      sleep: async (ms: number, _signal?: AbortSignal, kind?: string) => {
        waits.push({ ms, kind });
        if (kind === 'attempt') sleeps.push(ms);
        now += ms;
      },
      gate: new InProcessPanelReadGate(),
      ...options,
    },
    () => new Date('2026-10-13T08:00:00.000Z'),
  );
  return { source, sleeps, waits };
}

const SCOPE = { tenantId: '11111111-1111-4111-8111-111111111111' } as never;
const NAMES = ['acc01', 'acc02', 'acc03', 'acc04', 'acc05'];

/** Every request the inventory sent was a read: the token exchange or a GET. */
function onlyReads(panel: Panel): boolean {
  return panel.requests.every(
    (r) => (r.method === 'GET' || r.method === 'POST') && r.effect === 'READ',
  );
}

describe('the inventory read: attempts under the SAME strict criterion', () => {
  it('a panel that moves during the first double walk, then settles: complete on attempt 2', async () => {
    const panel = panelOf(NAMES);
    // Walk 1 (attempt 1): an account is deleted after the first page — the total moves.
    panel.beforePage = (walk, offset) => {
      if (walk === 1 && offset === 2) panel.names = panel.names.filter((n) => n !== 'acc05');
      return undefined;
    };
    const { source, sleeps } = sourceFor(panel);
    const read = await source.read(SCOPE, 'panel');
    expect(read).toMatchObject({ ok: true, complete: true, accounts: 4 });
    expect(read.diagnostics).toMatchObject({ attempts: 2, pagination: null, status: null });
    expect(read.diagnostics?.walks).toHaveLength(2);
    expect(sleeps).toEqual([INVENTORY_RETRY_DELAYS_MS[0]]);
    expect(onlyReads(panel)).toBe(true);
    expect(source.requestCounts().refusedWrites).toBe(0);
  });

  it('a panel that never settles: INCOMPLETE after exactly INVENTORY_READ_ATTEMPTS, never indexed — on ONE login', async () => {
    const panel = panelOf(NAMES);
    let created = 0;
    // Every walk, an account is created mid-walk (a live bot still selling).
    panel.beforePage = (_walk, offset) => {
      if (offset === 2) panel.names.push(`new${String((created += 1))}`);
      return undefined;
    };
    const { source, sleeps } = sourceFor(panel);
    const read = await source.read(SCOPE, 'panel');
    expect(read).toMatchObject({ ok: true, complete: false, reason: 'TOTAL_CHANGED' });
    expect(read.diagnostics?.attempts).toBe(INVENTORY_READ_ATTEMPTS);
    expect(sleeps).toEqual([...INVENTORY_RETRY_DELAYS_MS]);
    // Three attempts, one walk each (an inconsistent first walk ends the attempt), and the
    // read's one login reused by all of them.
    expect(panel.tokenExchanges).toBe(1);
    expect(read.diagnostics?.load).toMatchObject({ logins: 1, tokenReuses: 2 });
    expect('index' in read).toBe(false);
  });

  it('an unstable page order (a row twice, another never): COUNT_MISMATCH, with the evidence that shows it', async () => {
    const panel = panelOf(NAMES);
    // Page 2 starts one row early: acc02 again, and acc03 is never returned.
    panel.rows = (all, offset, limit) =>
      all.slice(offset === 2 ? 1 : offset, (offset === 2 ? 1 : offset) + limit);
    const { source } = sourceFor(panel);
    const read = await source.read(SCOPE, 'panel');
    expect(read).toMatchObject({ ok: true, complete: false, reason: 'COUNT_MISMATCH' });
    expect(read.diagnostics?.walks[0]).toMatchObject({
      reportedTotal: 5,
      duplicateRows: 1,
      distinctUsernames: 4,
    });
    expect(read.diagnostics?.attempts).toBe(INVENTORY_READ_ATTEMPTS);
  });

  it('a page that timed out is asked again within the SAME walk, after a backoff; the read is complete in one attempt', async () => {
    const panel = panelOf(NAMES);
    let timedOut = false;
    panel.beforePage = (_walk, offset) => {
      if (offset === 2 && !timedOut) {
        timedOut = true;
        return { ok: false, failure: 'TIMEOUT', status: null };
      }
      return undefined;
    };
    const { source, sleeps, waits } = sourceFor(panel);
    const read = await source.read(SCOPE, 'panel');
    expect(read).toMatchObject({ ok: true, complete: true, accounts: 5 });
    expect(read.diagnostics?.attempts).toBe(1);
    expect(sleeps).toEqual([]);
    expect(waits.filter((w) => w.kind === 'backoff').map((w) => w.ms)).toEqual([
      INVENTORY_BACKOFF_MS[0],
    ]);
    expect(read.diagnostics?.load).toMatchObject({ retries: 1, logins: 1 });
  });

  it('a panel that always times out: a FAILED read once the ONE retry budget is spent — no attempt starts over, no storm', async () => {
    const panel = panelOf(NAMES);
    panel.beforePage = () => ({ ok: false, failure: 'TIMEOUT', status: null });
    const { source, sleeps, waits } = sourceFor(panel);
    const read = await source.read(SCOPE, 'panel');
    expect(read).toMatchObject({ ok: false, failure: 'TIMEOUT' });
    expect(read.diagnostics).toMatchObject({ attempts: 1, walks: [] });
    const budget = DEFAULT_PANEL_READ_POLICY.maxRetries;
    expect(read.diagnostics?.load).toMatchObject({ retries: budget, logins: 1 });
    // One login, then the page once and once per retry: nothing else reached the panel.
    expect(panel.requests).toHaveLength(1 + 1 + budget);
    expect(sleeps).toEqual([]);
    expect(waits.filter((w) => w.kind === 'backoff').map((w) => w.ms)).toEqual(
      INVENTORY_BACKOFF_MS.slice(0, budget),
    );
  });

  it("a rate limit (429) waits the panel's own Retry-After, then asks the same page again", async () => {
    const panel = panelOf(NAMES);
    let limited = 0;
    panel.beforePage = () =>
      limited++ < 1
        ? { ...answer(429, { detail: 'slow down' }), headers: { 'retry-after': '7' } }
        : undefined;
    const { source, sleeps, waits } = sourceFor(panel);
    const read = await source.read(SCOPE, 'panel');
    expect(read).toMatchObject({ ok: true, complete: true });
    expect(sleeps).toEqual([]);
    expect(waits.filter((w) => w.kind === 'retry-after').map((w) => w.ms)).toEqual([7_000]);
  });

  it('a 429 asking for longer than the cap is not asked again: the read fails RATE_LIMITED, nothing more is sent', async () => {
    const panel = panelOf(NAMES);
    panel.beforePage = () => ({
      ...answer(429, { detail: 'come back later' }),
      headers: { 'retry-after': String(DEFAULT_PANEL_READ_POLICY.maxRetryAfterMs / 1000 + 1) },
    });
    const { source, waits } = sourceFor(panel);
    expect(await source.read(SCOPE, 'panel')).toMatchObject({ ok: false, failure: 'RATE_LIMITED' });
    expect(panel.listCalls).toBe(1);
    expect(waits.filter((w) => w.kind === 'retry-after')).toEqual([]);
  });

  it('a refused login is NEVER retried: one token exchange (a lockout is worse than a refusal)', async () => {
    const panel = panelOf(NAMES);
    panel.login = 'refused';
    const { source, sleeps, waits } = sourceFor(panel);
    const read = await source.read(SCOPE, 'panel');
    expect(read).toMatchObject({ ok: false, failure: 'AUTHENTICATION_FAILED' });
    expect(panel.tokenExchanges).toBe(1);
    expect(sleeps).toEqual([]);
    expect(waits.filter((w) => w.kind === 'backoff' || w.kind === 'retry-after')).toEqual([]);
  });

  it('a page shape a second attempt would meet identically is not retried', async () => {
    const panel = panelOf(NAMES);
    panel.beforePage = () => answer(200, ['not', 'a', 'page']);
    const { source } = sourceFor(panel);
    const read = await source.read(SCOPE, 'panel');
    expect(read).toMatchObject({ ok: false, failure: 'MALFORMED_RESPONSE' });
    expect(read.diagnostics).toMatchObject({ attempts: 1, pagination: 'NOT_A_PAGE' });
    expect(panel.listCalls).toBe(1);
  });

  it('a 429 at the LOGIN is not asked again (a login limiter counts every attempt)', async () => {
    const panel = panelOf(NAMES);
    panel.login = 'rate-limited';
    const { source, sleeps } = sourceFor(panel);
    expect(await source.read(SCOPE, 'panel')).toMatchObject({ ok: false, failure: 'RATE_LIMITED' });
    expect(panel.tokenExchanges).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('a 4xx on a list page is not asked again; a 5xx is, after a backoff', async () => {
    const bad = panelOf(NAMES);
    bad.beforePage = () => answer(404, { detail: 'Not Found' });
    const one = sourceFor(bad);
    expect(await one.source.read(SCOPE, 'panel')).toMatchObject({
      ok: false,
      failure: 'PROVIDER_ERROR',
    });
    expect(bad.listCalls).toBe(1);
    expect(one.waits.filter((w) => w.kind === 'backoff')).toEqual([]);

    const flaky = panelOf(NAMES);
    let failed = false;
    flaky.beforePage = () => {
      if (failed) return undefined;
      failed = true;
      return answer(502, { detail: 'Bad Gateway' });
    };
    const two = sourceFor(flaky);
    expect(await two.source.read(SCOPE, 'panel')).toMatchObject({ ok: true, complete: true });
    expect(two.waits.filter((w) => w.kind === 'backoff')).toHaveLength(1);
  });

  it('without `attempts` (the CLI, the rehearsal walk) a read is made once, as before', async () => {
    const panel = panelOf(NAMES);
    panel.beforePage = (walk, offset) => {
      if (walk === 1 && offset === 2) panel.names.pop();
      return undefined;
    };
    const { source, sleeps } = sourceFor(panel, { attempts: undefined });
    const read = await source.read(SCOPE, 'panel');
    expect(read).toMatchObject({ complete: false, diagnostics: { attempts: 1 } });
    expect(sleeps).toEqual([]);
    expect(panel.tokenExchanges).toBe(1);
  });

  it('a lost lease ends the REAL pause at once and starts no further attempt (no read after it)', async () => {
    const panel = panelOf(NAMES);
    const lease = new AbortController();
    // Attempt 1 comes out incomplete; the lease is lost 10 ms into the 15 s pause.
    panel.beforePage = (walk, offset) => {
      if (walk === 1 && offset === 2) {
        panel.names.pop();
        setTimeout(() => {
          lease.abort(new Error('lease lost'));
        }, 10);
      }
      return undefined;
    };
    const source = new RickpanelInventorySource(
      {
        panel: async () => ({ baseUrl: 'https://panel.invalid', providerType: 'rickpanel' }),
        credentials: async () => ({ username: 'admin', password: 'synthetic', apiToken: null }),
        http: () => clientOf(panel),
      },
      // No `sleep` seam: the real pause, which must end on the signal, not after 15 s. No
      // pacing, so the only long wait is the pause between attempts.
      {
        pageSize: 2,
        attempts: INVENTORY_READ_ATTEMPTS,
        signal: lease.signal,
        requestIntervalMs: 0,
        gate: new InProcessPanelReadGate(),
      },
      () => new Date('2026-10-13T08:00:00.000Z'),
    );
    const started = Date.now();
    await expect(source.read(SCOPE, 'panel')).rejects.toThrow('lease lost');
    expect(Date.now() - started).toBeLessThan(5_000);
    // Nothing was sent after the lease was lost.
    const requestsAtAbort = panel.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(panel.requests).toHaveLength(requestsAtAbort);
    expect(panel.tokenExchanges).toBe(1);
  });

  it('a lease lost during the pause between attempts is checked before the next attempt', async () => {
    const panel = panelOf(NAMES);
    panel.beforePage = (walk, offset) => {
      if (walk === 1 && offset === 2) panel.names.pop();
      return undefined;
    };
    const lease = new AbortController();
    let now = 0;
    const { source } = sourceFor(panel, {
      clock: () => now,
      sleep: async (ms: number, _signal?: AbortSignal, kind?: string) => {
        now += ms;
        if (kind === 'attempt') lease.abort(new Error('lease lost'));
      },
      signal: lease.signal,
    });
    await expect(source.read(SCOPE, 'panel')).rejects.toThrow('lease lost');
    // The first attempt's one walk only: no request after the pause.
    expect(panel.listCalls).toBe(2);
    expect(panel.tokenExchanges).toBe(1);
  });

  it('attempts: 1 reads once', async () => {
    const panel = panelOf(NAMES);
    panel.beforePage = (walk, offset) => {
      if (walk === 1 && offset === 2) panel.names.pop();
      return undefined;
    };
    const { source, sleeps } = sourceFor(panel, { attempts: 1 });
    expect(await source.read(SCOPE, 'panel')).toMatchObject({ complete: false });
    expect(sleeps).toEqual([]);
  });

  it('inventoryRetryable: only an incomplete answer starts another attempt (failures were retried by the session)', () => {
    const incomplete = {
      ok: true,
      complete: false,
      reason: 'WALKS_DIFFER',
      evidence: { first: {} as never, second: null },
    } as const;
    expect(inventoryRetryable(incomplete)).toBe(true);
    for (const failure of [
      'TIMEOUT',
      'UNREACHABLE',
      'RATE_LIMITED',
      'PROVIDER_ERROR',
      'AUTHENTICATION_FAILED',
      'AUTHENTICATION_REQUIRES_INTERACTION',
      'TLS_FAILED',
      'BLOCKED_TARGET',
      'MALFORMED_RESPONSE',
    ] as const) {
      expect(inventoryRetryable({ ok: false, failure, status: null }), failure).toBe(false);
      expect(inventoryRetryable({ ok: false, failure, status: 503 }), failure).toBe(false);
    }
  });
});

// --- the plan's digest binds what the read DECIDED, and nothing that moves by the minute --------

const TENANT = '11111111-1111-4111-8111-111111111111';
const PANEL_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PANEL_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

async function planWith(
  inventories: ReadonlyMap<string, LegacyInventoryRead>,
  review?: ServiceReviewInputs,
) {
  const connector = new FixtureLegacySourceConnector(buildSyntheticLegacyDataset() as never);
  const snapshot = await readFromSession(connector.label, await connector.open());
  const mapping = parsePanelMapping(syntheticMappingFile(TENANT, PANEL_A, PANEL_B), TENANT);
  return planLegacyImport({
    snapshot,
    mapping,
    salesCurrency: 'IRT',
    existingCustomers: new Map(),
    existingOpenings: new Map(),
    trialOverrides: new Map(),
    trialDecided: new Set(),
    existingShapes: new Map(),
    tariffCandidates: [
      {
        id: 'p-30',
        status: 'ACTIVE',
        audience: 'EVERYONE',
        durationDays: 30,
        trafficBytes: 30n * 1024n ** 3n,
        price: money(200_000n, 'IRT'),
        panelBound: true,
        categoryStatus: 'ACTIVE',
      },
    ],
    inventories,
    ...(review === undefined ? {} : { review }),
  } as never);
}

/** Panel A's complete read, every account's runtime changed (usage, state): a minute later. */
function aMinuteLater(): Map<string, LegacyInventoryRead> {
  const inventories = syntheticInventories(PANEL_A, PANEL_B);
  const a = inventories.get(PANEL_A);
  if (a === undefined || !a.ok || !a.complete) throw new Error('fixture');
  const runtime = new Map(
    [...a.runtime].map(([name, facts]) => [
      name,
      {
        ...facts,
        state: 'limited' as const,
        usage: { usedBytes: 123_456n, totalBytes: null, expiresAt: null },
      },
    ]),
  );
  inventories.set(PANEL_A, { ...a, runtime, states: { limited: a.accounts } });
  return inventories;
}

/** Panel A's complete read with one account's exact spelling changed (renamed on the panel). */
function respelled(): { inventories: Map<string, LegacyInventoryRead>; key: string } {
  const inventories = syntheticInventories(PANEL_A, PANEL_B);
  const a = inventories.get(PANEL_A);
  if (a === undefined || !a.ok || !a.complete) throw new Error('fixture');
  const [key, spellings] = [...a.index.usernames].find(([, s]) => s.length === 1) ?? [];
  if (key === undefined || spellings === undefined) throw new Error('fixture');
  const usernames = new Map(a.index.usernames);
  usernames.set(key, [key.toUpperCase()]);
  inventories.set(PANEL_A, { ...a, index: { panelId: PANEL_A, usernames } });
  return { inventories, key };
}

describe('the plan digest (v2): the decisions the live read made, not the runtime it carried', () => {
  it('usage and state moving between two complete reads change NOTHING (no needless refusal)', async () => {
    const dry = await planWith(syntheticInventories(PANEL_A, PANEL_B));
    const apply = await planWith(aMinuteLater());
    expect(planTalliesDigest(apply)).toBe(planTalliesDigest(dry));
  });

  it('the same tallies with another account to adopt: ANOTHER digest', async () => {
    const dry = await planWith(syntheticInventories(PANEL_A, PANEL_B));
    const { inventories, key } = respelled();
    const apply = await planWith(inventories);
    const moved = apply.services.filter(
      (s) =>
        s.decision.category === 'ADOPTION_ELIGIBLE' &&
        s.decision.providerUsername === key.toUpperCase(),
    );
    expect(moved.length).toBeGreaterThan(0);
    // Every count is the same — only WHICH account an invoice adopts moved.
    expect(apply.tallies).toEqual(dry.tallies);
    expect(planTalliesDigest(apply)).not.toBe(planTalliesDigest(dry));
  });

  it('servicesDecisionDigest does not depend on the row order', async () => {
    const plan = await planWith(syntheticInventories(PANEL_A, PANEL_B));
    expect(servicesDecisionDigest([...plan.services].reverse())).toBe(
      servicesDecisionDigest(plan.services),
    );
  });

  it("an owner's ownership decision changed after the dry run: another digest, and the counts say which", async () => {
    const dry = await planWith(syntheticInventories(PANEL_A, PANEL_B));
    const eligible = dry.services.find((s) => s.decision.category === 'ADOPTION_ELIGIBLE');
    if (eligible === undefined) throw new Error('fixture');
    const apply = await planWith(syntheticInventories(PANEL_A, PANEL_B), {
      ownershipHold: new Set([eligible.invoice.idInvoice]),
    });
    expect(planTalliesDigest(apply)).not.toBe(planTalliesDigest(dry));
    const counts = mismatchCounts(dryRunOf(dry), planTalliesRefusalCounts(apply));
    const c = Object.fromEntries(counts.map((x) => [x.code, x.count]));
    expect(c['apply:services:ADOPTION_ELIGIBLE']).toBe(
      (c['dryrun:services:ADOPTION_ELIGIBLE'] ?? NaN) - 1,
    );
    expect(c['apply:services:AMBIGUOUS_OWNERSHIP']).toBe(
      (c['dryrun:services:AMBIGUOUS_OWNERSHIP'] ?? NaN) + 1,
    );
  });
});

// --- what the refusal records: both sides of every number that moved -----------------------------

/** The approved dry run's report, as the adapter summarises a plan (the parts compared). */
function dryRunOf(
  plan: Awaited<ReturnType<typeof planWith>>,
): Pick<LegacyMigrationDryRunReport, 'sections' | 'warnings'> {
  const t = plan.tallies;
  const line = (section: string, source: number, imported: number) => ({
    section,
    source,
    imported,
    archived: 0,
    skipped: 0,
    quarantined: 0,
  });
  const unread = plan.inventories.filter((p) => !p.complete).length;
  return {
    sections: [
      line('customers', t.customers.source, t.customers.new),
      line('customers:existing', t.customers.existing, 0),
      line('wallet_openings', t.wallet.positive.count, 0),
      line('legacy_debts', t.wallet.negative.count, 0),
      line('products', t.products.distinctShapes, 0),
      line('services', t.services.candidates, t.services.categories.ADOPTION_ELIGIBLE),
    ],
    warnings: [
      ...Object.entries(t.services.categories)
        .filter(([code, count]) => code !== 'ADOPTION_ELIGIBLE' && count > 0)
        .map(([code, count]) => ({ code, count })),
      ...(unread > 0 ? [{ code: 'PROVIDER_INVENTORY_INCOMPLETE', count: unread }] : []),
    ],
  };
}

function incompleteA(reason: string): Map<string, LegacyInventoryRead> {
  const inventories = syntheticInventories(PANEL_A, PANEL_B);
  inventories.set(PANEL_A, { ok: true, complete: false, reason });
  return inventories;
}

describe('mismatchCounts: what DRY_RUN_MISMATCH records on the row', () => {
  it('the reported shape: dry run on an incomplete panel, import on a complete one', async () => {
    const dry = await planWith(incompleteA('WALKS_DIFFER'));
    const apply = await planWith(syntheticInventories(PANEL_A, PANEL_B));
    const counts = mismatchCounts(dryRunOf(dry), planTalliesRefusalCounts(apply));
    const c = new Map(counts.map((x) => [x.code, x.count]));
    expect(c.get('dryrun:panels:inventory_incomplete')).toBe(1);
    expect(c.get('apply:panels:inventory_incomplete')).toBe(0);
    expect(c.get('dryrun:services:INVENTORY_INCOMPLETE')).toBeGreaterThan(0);
    expect(c.get('apply:services:INVENTORY_INCOMPLETE')).toBe(0);
    // The money did not move, so it is not listed.
    for (const code of c.keys()) expect(code).not.toMatch(/customers|wallet/u);
    // Every number is a pair, and nothing but a code and a count.
    for (const { code, count } of counts) {
      expect(code).toMatch(/^(dryrun|apply):[a-z_]+:[A-Za-z_]+$/u);
      expect(Number.isSafeInteger(count) && count >= 0).toBe(true);
      const other = code.startsWith('dryrun:')
        ? code.replace('dryrun:', 'apply:')
        : code.replace('apply:', 'dryrun:');
      expect(c.has(other)).toBe(true);
    }
  });

  it('an approval of the v1 digest of this very plan: said as an outdated format, nothing else', async () => {
    const plan = await planWith(syntheticInventories(PANEL_A, PANEL_B));
    expect(planTalliesDigestV1(plan)).not.toBe(planTalliesDigest(plan));
    expect(
      mismatchCounts(dryRunOf(plan), {
        ...planTalliesRefusalCounts(plan),
        [PLAN_DIGEST_FORMAT_OUTDATED]: 1,
      }),
    ).toEqual([{ code: 'plan:digest_format_outdated', count: 1 }]);
  });

  it('a digest that moved while no compared number did: said, not hidden', async () => {
    const dry = await planWith(syntheticInventories(PANEL_A, PANEL_B));
    const apply = await planWith(respelled().inventories);
    expect(mismatchCounts(dryRunOf(dry), planTalliesRefusalCounts(apply))).toEqual([
      { code: 'plan:changed_beyond_compared_counts', count: 1 },
    ]);
  });
});

// --- the rule both sides share, and the reasons the report gives ---------------------------------

describe('legacyMigrationDryRunInventoryIncomplete (the contract rule)', () => {
  it('its fallback names a category the importer really has (a rename would break it silently)', () => {
    expect(SERVICE_CANDIDATE_CATEGORIES).toContain('INVENTORY_INCOMPLETE');
  });

  it('counts the provider warning, and fails closed on a report from before it', () => {
    expect(legacyMigrationDryRunInventoryIncomplete(null)).toBe(0);
    expect(legacyMigrationDryRunInventoryIncomplete([])).toBe(0);
    expect(legacyMigrationDryRunInventoryIncomplete([{ code: 'PROVIDER_MISSING', count: 9 }])).toBe(
      0,
    );
    expect(
      legacyMigrationDryRunInventoryIncomplete([
        { code: 'PROVIDER_INVENTORY_INCOMPLETE', count: 2 },
        { code: 'PROVIDER_INVENTORY_INCOMPLETE:TIMEOUT', count: 2 },
      ]),
    ).toBe(2);
    expect(
      legacyMigrationDryRunInventoryIncomplete([{ code: 'INVENTORY_INCOMPLETE', count: 1_234 }]),
    ).toBe(1);
    // The table verdict has its own code and is not a panel read.
    expect(
      legacyMigrationDryRunInventoryIncomplete([{ code: 'TABLE_INVENTORY_INCOMPLETE', count: 3 }]),
    ).toBe(0);
  });
});

describe('providerIncompleteReasons', () => {
  it('one warning per reason, and a reason outside the closed shape is UNKNOWN', () => {
    const report = {
      sections: {
        provider: {
          panels: [
            { complete: false, reason: 'COUNT_MISMATCH' },
            { complete: false, reason: 'COUNT_MISMATCH' },
            { complete: false, reason: 'TIMEOUT' },
            { complete: false, reason: 'user Alice not found' },
            { complete: true, reason: null },
          ],
        },
      },
    } as never;
    expect(providerIncompleteReasons(report)).toEqual([
      { code: 'PROVIDER_INVENTORY_INCOMPLETE:COUNT_MISMATCH', count: 2 },
      { code: 'PROVIDER_INVENTORY_INCOMPLETE:TIMEOUT', count: 1 },
      { code: 'PROVIDER_INVENTORY_INCOMPLETE:UNKNOWN', count: 1 },
    ]);
  });
});

describe('the dry run report: the provider warnings, and the table verdict under its own code', () => {
  const report = (panels: unknown[]) =>
    ({ verdict: 'DRY_RUN', sections: { provider: { panels } } }) as never;
  const summarise = (panels: unknown[], inventoryVerdict = 'COMPLETE') =>
    dryRunReportOf(report(panels), { wallet: { currency: 'IRT' } } as never, null, null, [], {
      invoiceArchiveRows: 0,
      holdChangedCategory: null,
      converterTotalsAbsent: false,
      inventoryVerdict,
      tables: [{ name: 'mystery', class: 'UNCLASSIFIED', rows: 1 }] as never,
      coverage: null,
    }).warnings;

  it('names the incomplete production panels and why, and nothing when every read held', () => {
    expect(
      summarise([
        { complete: false, reason: 'WALKS_DIFFER' },
        { complete: true, reason: null },
      ]),
    ).toEqual([
      { code: 'PROVIDER_INVENTORY_INCOMPLETE', count: 1 },
      { code: 'PROVIDER_INVENTORY_INCOMPLETE:WALKS_DIFFER', count: 1 },
    ]);
    expect(summarise([{ complete: true, reason: null }])).toEqual([]);
  });

  it('an incomplete TABLE inventory is TABLE_INVENTORY_INCOMPLETE, never the services code', () => {
    const warnings = summarise([{ complete: true, reason: null }], 'INCOMPLETE');
    expect(warnings).toEqual([{ code: 'TABLE_INVENTORY_INCOMPLETE', count: 1 }]);
    expect(legacyMigrationDryRunInventoryIncomplete(warnings)).toBe(0);
  });
});

describe('the apply, before the protective backup: an approval from before the gate', () => {
  it('a production-like apply of a dry run planned on an incomplete panel stops at TARGET', async () => {
    const adapters = new NxpkgMigrationAdapters({ target: null, guardEnv: () => ({}) } as never);
    const context = {
      importId: 'import-1',
      verifyReport: { synthetic: false },
      targetAck: null,
      dryRunReport: { warnings: [{ code: 'INVENTORY_INCOMPLETE', count: 1_234 }] },
    } as never;
    const refusal = await adapters.precheck(context, 'TARGET').catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(LegacyMigrationStepFailure);
    expect(refusal).toMatchObject({
      code: 'DRY_RUN_MISMATCH',
      counts: [{ code: 'dryrun:panels:inventory_incomplete', count: 1 }],
    });
    // A complete dry run that reported no plan digest cannot bind the import: refused too.
    const undigested = {
      ...(context as object),
      dryRunReport: { warnings: [], planTalliesDigest: null },
    } as never;
    await expect(adapters.precheck(undigested, 'TARGET')).rejects.toMatchObject({
      code: 'DRY_RUN_MISMATCH',
      counts: [{ code: 'dryrun:plan:digest_missing', count: 1 }],
    });
    // An approval of a report stored before the field existed: the key is ABSENT, not null.
    // Refused the same way — `runMode` would otherwise hand the importer no digest at all.
    const unkeyed = { ...(context as object), dryRunReport: { warnings: [] } } as never;
    await expect(adapters.precheck(unkeyed, 'TARGET')).rejects.toMatchObject({
      code: 'DRY_RUN_MISMATCH',
      counts: [{ code: 'dryrun:plan:digest_missing', count: 1 }],
    });
    // A complete dry run passes this gate and meets the next one (the acknowledgement).
    const complete = {
      ...(context as object),
      dryRunReport: { warnings: [], planTalliesDigest: 'a'.repeat(64) },
    } as never;
    await expect(adapters.precheck(complete, 'TARGET')).rejects.toMatchObject({
      blocker: 'TARGET_ACK_MISSING',
    });
  });
});
