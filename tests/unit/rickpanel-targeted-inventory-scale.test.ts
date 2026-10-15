import { describe, expect, it } from 'vitest';
import type { ProviderHttpClient, ProviderHttpRequest, ProviderHttpResult } from '@nexa/contracts';
import {
  RickpanelInventorySource,
  TARGETED_MAX_WALKS,
} from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/rickpanel-inventory-source';
import { InProcessPanelReadGate } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/panel-read-gate';
import { INVENTORY_REQUEST_INTERVAL_MS } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/rickpanel-read-session';
import { indexCovers } from '../../apps/api/src/modules/platform/legacy-import/application/legacy-service-matching';
import type { LegacyInventoryRead } from '../../apps/api/src/modules/platform/legacy-importer/application/ports';

/**
 * Per-name inventory resolution at production scale, on a FAKE clock (no real sleeping, no
 * socket, no database): a synthetic RickPanel of 100 000 accounts, 77 000 of which the backup
 * needs, read by the Web Admin's targeted source at its defaults — page size 100, one request
 * a second — while the panel keeps selling under every walk: sales and manual accounts
 * appended (the panel's insertion order, oldest first, `created_at` on every row), single
 * deletions behind the cursor, and — during the first walk only — needed accounts deleted and
 * 15-row deletion bursts that break that walk's chain.
 *
 * What it pins: the second walk is gap-free, but the single deletions behind its cursor leave
 * the needed rows it read before them unconfirmed — any of them could have been the deleted
 * row — so a third walk is made, and returning those same rows (same name and creation time)
 * confirms them. Decisions rest on the second walk: every needed name is decided and decided
 * RIGHT — present exactly when the panel held it when that walk ended, checked name by name
 * against the panel's own state at that moment; nothing the backup does not need is indexed;
 * not one exact lookup is sent; one login; and what the read costs in requests, simulated time
 * and heap. SYNTHETIC data only.
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
const iso = (t: number) => new Date(Date.UTC(2020, 0, 1) + t * 1000).toISOString();

interface ScalePanel {
  names: string[];
  created: Map<string, number>;
  clock: number;
  requests: { logins: number; pages: number; lookups: number };
  walk: number;
  page: number;
  /** The panel's accounts as each walk ended (taken as the next walk begins). */
  endOfWalk: string[][];
  churn: { appended: number; deletedUnneeded: number; deletedNeeded: string[]; bursts: number };
  peakHeap: number;
  /** Bursts in every walk (the liveness bound), not only the first. */
  burstEveryWalk: boolean;
}

function scalePanel(burstEveryWalk = false): ScalePanel {
  const names = Array.from({ length: ACCOUNTS }, (_, i) => nameOf(i));
  return {
    names,
    created: new Map(names.map((n, i) => [n, i])),
    clock: ACCOUNTS,
    requests: { logins: 0, pages: 0, lookups: 0 },
    walk: 0,
    page: 0,
    endOfWalk: [],
    churn: { appended: 0, deletedUnneeded: 0, deletedNeeded: [], bursts: 0 },
    peakHeap: 0,
    burstEveryWalk,
  };
}

function append(panel: ScalePanel, username: string): void {
  panel.clock += 1;
  panel.created.set(username, panel.clock);
  panel.names.push(username);
  panel.churn.appended += 1;
}

/** Deletes up to `count` accounts behind the cursor matching `which`; returns their names. */
function deleteBehind(
  panel: ScalePanel,
  offset: number,
  count: number,
  which: (i: number) => boolean,
): string[] {
  const gone: string[] = [];
  for (let i = offset - PAGE_SIZE; i >= 0 && gone.length < count; i -= 1) {
    const n = panel.names[i] ?? '';
    if (n.startsWith('acc') && which(Number(n.slice(3)))) {
      panel.names.splice(i, 1);
      gone.push(n);
    }
  }
  return gone;
}

/**
 * Before a page at `offset`:
 * - every 5th page a Mirza sale, every 11th a manual account — both appended (insertion order);
 * - every 7th page one UNNEEDED account behind the cursor deleted (absorbed by the overlap);
 * - during the FIRST walk, every 25th page a NEEDED account behind the cursor deleted, and every
 *   40th page a burst of 15 unneeded ones (beyond the overlap: that walk is not gap-free).
 */
function churn(panel: ScalePanel, offset: number): void {
  const p = panel.page;
  if (p % 5 === 0) append(panel, `sale${String(panel.churn.appended).padStart(6, '0')}`);
  if (offset > 0 && p % 11 === 0) {
    append(panel, `manual${String(panel.churn.appended).padStart(6, '0')}`);
  }
  if (offset > PAGE_SIZE && p % 7 === 0) {
    panel.churn.deletedUnneeded += deleteBehind(panel, offset, 1, (i) => !isNeeded(i)).length;
  }
  const bursting = panel.walk === 1 || panel.burstEveryWalk;
  if (bursting && offset > PAGE_SIZE && p % 40 === 0) {
    panel.churn.deletedUnneeded += deleteBehind(panel, offset, 15, (i) => !isNeeded(i)).length;
    panel.churn.bursts += 1;
  }
  if (panel.walk === 1 && offset > PAGE_SIZE && p % 25 === 0) {
    panel.churn.deletedNeeded.push(...deleteBehind(panel, offset, 1, isNeeded));
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
        panel.requests.lookups += 1;
        return answer(500, { detail: 'no lookup expected' });
      }
      const query = new URLSearchParams(request.path.split('?')[1] ?? '');
      const offset = Number(query.get('offset'));
      const limit = Number(query.get('limit'));
      if (offset === 0) {
        if (panel.walk > 0) panel.endOfWalk.push([...panel.names]);
        panel.walk += 1;
      }
      churn(panel, offset);
      panel.page += 1;
      panel.requests.pages += 1;
      const users = panel.names.slice(offset, offset + limit).map((username) => ({
        username,
        status: 'active',
        created_at: iso(panel.created.get(username) ?? 0),
      }));
      return answer(200, { users, total: panel.names.length });
    },
  };
}

function sourceOf(panel: ScalePanel) {
  let now = 0;
  const source = new RickpanelInventorySource(
    {
      panel: async () => ({ baseUrl: 'https://panel.invalid', providerType: 'rickpanel' }),
      credentials: async () => ({ username: 'admin', password: 'synthetic', apiToken: null }),
      http: () => clientOf(panel),
    },
    {
      // The Web Admin's defaults: page size 100, one request a second.
      pageSize: PAGE_SIZE,
      requestIntervalMs: INVENTORY_REQUEST_INTERVAL_MS,
      clock: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
      gate: new InProcessPanelReadGate(),
      targeted: true,
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

function neededNames(): Map<string, string | null> {
  const needed = new Map<string, string | null>();
  for (let i = 0; i < ACCOUNTS; i += 1) if (isNeeded(i)) needed.set(nameOf(i), nameOf(i));
  return needed;
}

describe('per-name resolution at scale: 100 000 accounts, 77 000 needed, a panel that keeps selling', () => {
  it('decides every needed name right on the gap-free second walk, its survivors confirmed by a third; no lookup; one login; cost reported', async () => {
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
    expect(r).toMatchObject({ mode: 'TARGETED', reason: 'TOTAL_CHANGED', walks: 3, gapFree: true });
    expect(panel.churn.bursts).toBeGreaterThan(0); // the first walk was really broken
    expect(r.needed).toBe(77_000);
    expect(r.unresolved).toBe(0);
    expect(r.collisions).toBe(0);
    expect(r.present + r.absent).toBe(77_000);
    expect(panel.churn.deletedNeeded.length).toBeGreaterThan(0);
    expect(r.absent).toBe(panel.churn.deletedNeeded.length);

    // Ground truth, name by name: present exactly when the panel held it as the decision walk
    // (the second) ended.
    const held = new Set(panel.endOfWalk[1]);
    let wrong = 0;
    for (const name of needed.keys()) {
      if (!indexCovers(read.index, name)) wrong += 1;
      else if (read.index.usernames.has(name) !== held.has(name)) wrong += 1;
    }
    expect(wrong).toBe(0);
    expect(read.index.usernames.size).toBe(77_000 - r.absent);

    // The load on the panel: pages and one login, never a lookup.
    expect(panel.requests.lookups).toBe(0);
    expect(panel.requests.logins).toBe(1);
    const walks = read.diagnostics?.walks ?? [];
    expect(walks).toHaveLength(3);
    expect(walks.reduce((sum, w) => sum + w.pages, 0)).toBe(panel.requests.pages);
    // A walk is about total / 90 pages (each repeats 10 rows of the one before).
    for (const w of walks) {
      expect(w.pages).toBeGreaterThanOrEqual(1_100);
      expect(w.pages).toBeLessThanOrEqual(1_250);
    }
    const requests = panel.requests.logins + panel.requests.pages;
    expect(read.diagnostics?.load.requests).toBe(requests);
    const simulatedMs = clock();
    expect(simulatedMs).toBeLessThanOrEqual(requests * INVENTORY_REQUEST_INTERVAL_MS);
    const heapDeltaMb = (Math.max(panel.peakHeap, heapAfter) - heapBefore) / 1024 ** 2;
    // A peak, garbage included (three walks of parsed pages, collected lazily): measured about
    // 550 MB, while what the read retains after a collection measured under 10 MB.
    expect(heapDeltaMb).toBeLessThan(768);
    console.info(
      `[scale] accounts=${String(ACCOUNTS)} needed=77000 churn={appended:${String(panel.churn.appended)},` +
        `deletedUnneeded:${String(panel.churn.deletedUnneeded)},deletedNeeded:${String(panel.churn.deletedNeeded.length)},bursts:${String(panel.churn.bursts)}} ` +
        `requests=${String(requests)} (logins=1 pages=${String(panel.requests.pages)} [walk1=${String(walks[0]?.pages)} walk2=${String(walks[1]?.pages)} walk3=${String(walks[2]?.pages)}] lookups=0) ` +
        `resolution={present:${String(r.present)},absent:${String(r.absent)}} ` +
        `simulated=${(simulatedMs / 60_000).toFixed(1)}min peakHeapDelta=${heapDeltaMb.toFixed(1)}MB wall=${(wallMs / 1000).toFixed(1)}s`,
    );
  }, 120_000);

  it('bursts in every walk: three walks at most, then every needed name UNRESOLVED — none guessed', async () => {
    const panel = scalePanel(true);
    const needed = neededNames();
    const { source } = sourceOf(panel);
    const read = complete(await source.read(SCOPE, 'p1', { needed }));
    expect(read.resolution).toMatchObject({
      walks: TARGETED_MAX_WALKS,
      gapFree: false,
      present: 0,
      absent: 0,
      unresolved: 77_000,
    });
    expect(read.index.usernames.size).toBe(0);
    expect(panel.requests.lookups).toBe(0);
    console.info(
      `[scale-bursts] walks=${String(read.resolution?.walks)} pages=${String(panel.requests.pages)}`,
    );
  }, 180_000);
});
