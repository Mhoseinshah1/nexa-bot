import { describe, expect, it } from 'vitest';
import type { ProviderHttpClient, ProviderHttpRequest, ProviderHttpResult } from '@nexa/contracts';
import {
  INVENTORY_MAX_LOOKUPS,
  RickpanelInventorySource,
} from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/rickpanel-inventory-source';
import { InProcessPanelReadGate } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/panel-read-gate';
import { INVENTORY_REQUEST_INTERVAL_MS } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/rickpanel-read-session';
import { indexCovers } from '../../apps/api/src/modules/platform/legacy-import/application/legacy-service-matching';
import type { LegacyInventoryRead } from '../../apps/api/src/modules/platform/legacy-importer/application/ports';

/**
 * Per-name inventory resolution at production scale, on a FAKE clock (no real sleeping, no
 * socket, no database): a synthetic RickPanel of 100 000 accounts, 77 000 of which the backup
 * needs, read by the Web Admin's targeted source at its defaults — page size 100, one request
 * a second (`INVENTORY_REQUEST_INTERVAL_MS`), the default lookup bound — while the panel keeps
 * changing under both walks: sales appended, accounts created mid-list, accounts deleted
 * behind the cursor (so later rows slip past it), and needed accounts deleted during the
 * first walk.
 *
 * What it pins: the read completes; every needed name is decided and decided RIGHT (present
 * exactly when the panel still holds it — checked against the panel's own final state, name
 * by name); nothing the backup does not need is looked up or indexed; one login; the request
 * count is exactly pages + lookups + login; lookups are bounded; and what the read costs in
 * simulated time and heap. The numbers are printed for the report; the bounds asserted are
 * generous on purpose (a regression to a quadratic walk or an unbounded lookup storm trips
 * them; machine noise does not).
 *
 * Ground truth is exact because a needed account is only ever deleted during the FIRST walk:
 * one deleted during the second walk, after that walk passed it, was seen by both walks and is
 * (correctly, by the rule) present by walks — the apply's own read is what catches that, and
 * the digest refuses the apply (`tests/integration/nxpkg-live-panel-inventory.test.ts`, I).
 *
 * SYNTHETIC data only.
 */

const SCOPE = { tenantId: '11111111-1111-4111-8111-111111111111' } as never;
const STAMP = () => new Date('2026-10-14T08:00:00.000Z');
const ACCOUNTS = 100_000;
const PAGE_SIZE = 100;

const answer = (status: number, body: unknown): ProviderHttpResult =>
  ({ ok: true, status, headers: {}, bodyText: JSON.stringify(body), setCookie: [] }) as const;
const nameOf = (i: number) => `acc${String(i).padStart(6, '0')}`;
/** 77 of every 100 accounts are named by a live backup invoice. */
const isNeeded = (i: number) => i % 100 < 77;

interface ScalePanel {
  /** The panel's list order. */
  names: string[];
  held: Set<string>;
  requests: { logins: number; pages: number; lookups: number; lookupNames: string[] };
  /** Walk number (a page at offset 0 starts one) and page within the read. */
  walk: number;
  page: number;
  churn: { appended: number; inserted: number; deletedUnneeded: number; deletedNeeded: string[] };
  peakHeap: number;
}

function scalePanel(): ScalePanel {
  const names = Array.from({ length: ACCOUNTS }, (_, i) => nameOf(i));
  return {
    names,
    held: new Set(names),
    requests: { logins: 0, pages: 0, lookups: 0, lookupNames: [] },
    walk: 0,
    page: 0,
    churn: { appended: 0, inserted: 0, deletedUnneeded: 0, deletedNeeded: [] },
    peakHeap: 0,
  };
}

/**
 * The panel keeps selling under both walks. Before a page at `offset`:
 * - every 5th page a Mirza sale is appended (never needed);
 * - every 11th page an operator creates an account in the middle, behind the cursor (a row
 *   the walk will see twice — a duplicate, never a skip);
 * - every 7th page an UNNEEDED account behind the cursor is deleted (the next row slips past
 *   the walk, and may be a needed one);
 * - during the FIRST walk, every 25th page a NEEDED account behind the cursor is deleted.
 */
function churn(panel: ScalePanel, offset: number): void {
  const p = panel.page;
  const removeAt = (index: number) => {
    const [gone] = panel.names.splice(index, 1);
    if (gone !== undefined) panel.held.delete(gone);
    return gone;
  };
  if (p % 5 === 0) {
    const sale = `sale${String(panel.churn.appended).padStart(6, '0')}`;
    panel.names.push(sale);
    panel.held.add(sale);
    panel.churn.appended += 1;
  }
  if (offset > 0 && p % 11 === 0) {
    const manual = `manual${String(panel.churn.inserted).padStart(6, '0')}`;
    panel.names.splice(Math.floor(offset / 2), 0, manual);
    panel.held.add(manual);
    panel.churn.inserted += 1;
  }
  if (offset > PAGE_SIZE && p % 7 === 0) {
    // The last unneeded account at least one page behind the cursor.
    for (let i = offset - PAGE_SIZE; i >= 0; i -= 1) {
      const n = panel.names[i] ?? '';
      if (n.startsWith('acc') && !isNeeded(Number(n.slice(3)))) {
        removeAt(i);
        panel.churn.deletedUnneeded += 1;
        break;
      }
    }
  }
  if (panel.walk === 1 && offset > PAGE_SIZE && p % 40 === 0) {
    // A burst: 15 unneeded accounts behind the cursor deleted at once — more than the walk's
    // page overlap absorbs, so the first walk really skips rows (and is not gap-free).
    let removed = 0;
    for (let i = offset - PAGE_SIZE; i >= 0 && removed < 15; i -= 1) {
      const n = panel.names[i] ?? '';
      if (n.startsWith('acc') && !isNeeded(Number(n.slice(3)))) {
        removeAt(i);
        panel.churn.deletedUnneeded += 1;
        removed += 1;
      }
    }
  }
  if (panel.walk === 1 && offset > PAGE_SIZE && p % 25 === 0) {
    for (let i = offset - PAGE_SIZE; i >= 0; i -= 1) {
      const n = panel.names[i] ?? '';
      if (n.startsWith('acc') && isNeeded(Number(n.slice(3)))) {
        removeAt(i);
        panel.churn.deletedNeeded.push(n);
        break;
      }
    }
  }
}

function clientOf(panel: ScalePanel): ProviderHttpClient {
  return {
    send: async (request: ProviderHttpRequest) => {
      if (panel.requests.pages % 50 === 0) {
        panel.peakHeap = Math.max(panel.peakHeap, process.memoryUsage().heapUsed);
      }
      if (request.method === 'POST') {
        panel.requests.logins += 1;
        return answer(200, { access_token: 'token-1' });
      }
      if (request.path.startsWith('api/user/')) {
        const username = decodeURIComponent(request.path.slice('api/user/'.length));
        panel.requests.lookups += 1;
        panel.requests.lookupNames.push(username);
        return panel.held.has(username)
          ? answer(200, { username, status: 'active' })
          : answer(404, { detail: 'User not found' });
      }
      const query = new URLSearchParams(request.path.split('?')[1] ?? '');
      const offset = Number(query.get('offset'));
      const limit = Number(query.get('limit'));
      if (offset === 0) panel.walk += 1;
      churn(panel, offset);
      panel.page += 1;
      panel.requests.pages += 1;
      const users = panel.names
        .slice(offset, offset + limit)
        .map((username) => ({ username, status: 'active' }));
      return answer(200, { users, total: panel.names.length });
    },
  };
}

function sourceOf(panel: ScalePanel, options: Record<string, unknown> = {}) {
  let now = 0;
  const source = new RickpanelInventorySource(
    {
      panel: async () => ({ baseUrl: 'https://panel.invalid', providerType: 'rickpanel' }),
      credentials: async () => ({ username: 'admin', password: 'synthetic', apiToken: null }),
      http: () => clientOf(panel),
    },
    {
      // The Web Admin's defaults: page size 100, one request a second, the lookup bound.
      pageSize: PAGE_SIZE,
      requestIntervalMs: INVENTORY_REQUEST_INTERVAL_MS,
      clock: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
      gate: new InProcessPanelReadGate(),
      targeted: true,
      ...options,
    },
    STAMP,
  );
  return { source, clock: () => now };
}

type Complete = Extract<LegacyInventoryRead, { ok: true; complete: true }>;
function complete(read: LegacyInventoryRead): Complete {
  if (!read.ok || !read.complete) throw new Error(`expected a complete read: ${read.ok}`);
  return read;
}

/** Canonical name → the backup's exact spelling (the same here: every name is lowercase). */
function neededNames(): Map<string, string | null> {
  const needed = new Map<string, string | null>();
  for (let i = 0; i < ACCOUNTS; i += 1) if (isNeeded(i)) needed.set(nameOf(i), nameOf(i));
  return needed;
}

describe('per-name resolution at scale: 100 000 accounts, 77 000 needed, a panel that keeps selling', () => {
  it('completes at the defaults; every needed name decided against the panel’s final state; one login; requests = pages + lookups + login; bounded lookups; time and heap reported', async () => {
    const panel = scalePanel();
    const needed = neededNames();
    expect(needed.size).toBe(77_000);
    const { source, clock } = sourceOf(panel);
    const heapBefore = process.memoryUsage().heapUsed;
    const wallStart = performance.now();
    const read = complete(await source.read(SCOPE, 'p1', { needed }));
    const wallMs = performance.now() - wallStart;
    const heapAfter = process.memoryUsage().heapUsed;

    const r = read.resolution;
    if (r === undefined) throw new Error('expected a per-name resolution');
    expect(r.mode).toBe('TARGETED');
    expect(r.reason).toBe('TOTAL_CHANGED');
    expect(r.needed).toBe(77_000);
    expect(r.unresolved).toBe(0);
    expect(r.collisions).toBe(0);
    expect(r.presentByWalks + r.presentByLookup + r.absentByLookup).toBe(77_000);
    // Every needed account deleted during the read is proven absent, by its lookup.
    expect(r.absentByLookup).toBe(panel.churn.deletedNeeded.length);
    expect(panel.churn.deletedNeeded.length).toBeGreaterThan(0);
    // Rows the bursts made slip past the first walk were found again by lookup (single
    // deletions are absorbed by the page overlap and slip nothing).
    expect(r.presentByLookup).toBeGreaterThan(0);

    // Ground truth, name by name: present exactly when the panel still holds it.
    let wrong = 0;
    for (const name of needed.keys()) {
      if (!indexCovers(read.index, name)) wrong += 1;
      else if (read.index.usernames.has(name) !== panel.held.has(name)) wrong += 1;
    }
    expect(wrong).toBe(0);
    // Nothing the backup does not need is indexed or looked up.
    expect(read.index.usernames.size).toBe(77_000 - r.absentByLookup);
    // The first lookup is the canary — the lexically first account both walks saw — so no
    // 404 is trusted from a route that 404s everything; every other one is a needed name.
    const [canary, ...asked] = panel.requests.lookupNames;
    expect(canary).toBe(nameOf(0));
    for (const name of asked) expect(needed.has(name)).toBe(true);

    // The load on the panel.
    expect(panel.requests.logins).toBe(1);
    expect(r.lookups).toBe(panel.requests.lookups);
    expect(r.lookups).toBe(r.presentByLookup + r.absentByLookup + 1);
    expect(r.lookups).toBeLessThanOrEqual(INVENTORY_MAX_LOOKUPS);
    const walks = read.diagnostics?.walks ?? [];
    expect(walks).toHaveLength(2);
    const pages = walks.reduce((sum, w) => sum + w.pages, 0);
    expect(pages).toBe(panel.requests.pages);
    // A walk is about total / 90 pages (each page repeats 10 rows of the one before, so a
    // boundary stays chained under deletions), plus the rows the panel grew by while walked.
    for (const w of walks) {
      expect(w.pages).toBeGreaterThanOrEqual(1_100);
      expect(w.pages).toBeLessThanOrEqual(1_250);
    }
    const requests = panel.requests.logins + panel.requests.pages + panel.requests.lookups;
    expect(read.diagnostics?.load.requests).toBe(requests);
    // At one request a second, the read takes (requests − 1) seconds of panel time.
    const simulatedMs = clock();
    expect(read.diagnostics?.load.durationMs).toBe(simulatedMs);
    expect(simulatedMs).toBeGreaterThanOrEqual((requests - 1) * INVENTORY_REQUEST_INTERVAL_MS);
    expect(simulatedMs).toBeLessThanOrEqual(requests * INVENTORY_REQUEST_INTERVAL_MS);

    const peakHeapDeltaMb = (Math.max(panel.peakHeap, heapAfter) - heapBefore) / 1024 ** 2;
    // Generous: the 100 000-name panel itself, two walks' accounts and the index.
    expect(peakHeapDeltaMb).toBeLessThan(512);
    expect(wallMs).toBeLessThan(60_000);

    console.info(
      `[scale] accounts=${String(ACCOUNTS)} needed=${String(needed.size)} ` +
        `churn={appended:${String(panel.churn.appended)},inserted:${String(panel.churn.inserted)},` +
        `deletedUnneeded:${String(panel.churn.deletedUnneeded)},deletedNeeded:${String(panel.churn.deletedNeeded.length)}} ` +
        `requests=${String(requests)} (logins=${String(panel.requests.logins)} pages=${String(pages)} ` +
        `[walk1=${String(walks[0]?.pages)} walk2=${String(walks[1]?.pages)}] lookups=${String(r.lookups)}) ` +
        `resolution={walks:${String(r.presentByWalks)},lookupPresent:${String(r.presentByLookup)},` +
        `absent:${String(r.absentByLookup)}} simulated=${(simulatedMs / 60_000).toFixed(1)}min ` +
        `peakHeapDelta=${peakHeapDeltaMb.toFixed(1)}MB wall=${(wallMs / 1000).toFixed(1)}s`,
    );
  }, 120_000);

  it('the lookup bound holds at scale: past `maxLookups` a name is UNRESOLVED (never guessed), and not one more lookup is sent', async () => {
    const panel = scalePanel();
    const needed = neededNames();
    const { source } = sourceOf(panel, { maxLookups: 25 });
    const read = complete(await source.read(SCOPE, 'p1', { needed }));
    const r = read.resolution;
    if (r === undefined) throw new Error('expected a per-name resolution');
    expect(panel.requests.lookups).toBe(25);
    // The canary counts against the bound: 24 needed names were asked.
    expect(r.lookups).toBe(25);
    expect(r.presentByLookup + r.absentByLookup).toBe(24);
    expect(r.unresolved).toBeGreaterThan(0);
    expect(r.presentByWalks + r.presentByLookup + r.absentByLookup + r.unresolved).toBe(77_000);
    // An unresolved name is not covered: the matcher keeps its invoice INVENTORY_INCOMPLETE.
    let uncovered = 0;
    for (const name of needed.keys()) if (!indexCovers(read.index, name)) uncovered += 1;
    expect(uncovered).toBe(r.unresolved);
    expect(panel.requests.logins).toBe(1);
    console.info(
      `[scale-bound] maxLookups=25 lookups=${String(r.lookups)} unresolved=${String(r.unresolved)} ` +
        `pages=${String(panel.requests.pages)}`,
    );
  }, 120_000);
});
