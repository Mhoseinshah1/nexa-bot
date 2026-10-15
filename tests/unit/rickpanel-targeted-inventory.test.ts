import { describe, expect, it } from 'vitest';
import type { ProviderHttpClient, ProviderHttpRequest } from '@nexa/contracts';
import {
  RickpanelInventorySource,
  TARGETED_MAX_WALKS,
  sameRelativeOrder,
} from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/rickpanel-inventory-source';
import {
  RickpanelInventoryReader,
  readOnlyRickpanelHttp,
} from '../../apps/api/src/modules/platform/providers/infrastructure/rickpanel-inventory';
import { InProcessPanelReadGate } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/panel-read-gate';
import {
  decideNeededNames,
  neededNamesByPanel,
} from '../../apps/api/src/modules/platform/legacy-importer/application/inventory-resolution';
import { indexCovers } from '../../apps/api/src/modules/platform/legacy-import/application/legacy-service-matching';
import { observedAtFor } from '../../apps/api/src/modules/platform/legacy-importer/application/service-outcomes';
import type { LegacyInventoryRead } from '../../apps/api/src/modules/platform/legacy-importer/application/ports';
import {
  importableLegacyUserIds,
  planLegacyImport,
} from '../../apps/api/src/modules/platform/legacy-importer/application/plan';
import { parsePanelMapping } from '../../apps/api/src/modules/platform/legacy-importer/application/panel-mapping';
import { readFromSession } from '../../apps/api/src/modules/platform/legacy-importer/application/source-snapshot';
import { FixtureLegacySourceConnector } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/fixture-legacy-source';
import {
  providerChurnWarnings,
  providerIncomplete,
} from '../../apps/api/src/modules/platform/legacy-migration/infrastructure/nxpkg-migration-adapters';
import { buildSyntheticLegacyDataset } from '../fixtures/legacy/synthetic-legacy';
import { syntheticInventories, syntheticMappingFile } from '../fixtures/legacy/synthetic-support';

/**
 * Per-name inventory resolution (`docs/rickpanel-inventory.md` §Per-name resolution). The owner
 * keeps Mirza selling while a dry run reads the live RickPanel, so `TOTAL_CHANGED` is the normal
 * case. Owner decision on #283 (option 2): no case-ambiguous account is ever adopted and no 404
 * is ever proof of absence. A name is decided only on a GAP-FREE last walk — rows oldest first by
 * `created_at` (one order, verified), overlapping pages chained by name and creation time, no
 * insertion ahead of the cursor missed, ended at its own total — and no exact lookup is sent.
 * SYNTHETIC data, fake panels only.
 */

const SCOPE = { tenantId: '11111111-1111-4111-8111-111111111111' } as never;
const STAMP = () => new Date('2026-10-14T08:00:00.000Z');

const answer = (status: number, body: unknown) =>
  ({ ok: true, status, headers: {}, bodyText: JSON.stringify(body), setCookie: [] }) as const;

const name = (i: number) => `acc${String(i).padStart(5, '0')}`;
/** Needed names, each spelled in the backup exactly as on the panel. */
const need = (names: readonly string[]) => new Map(names.map((n) => [n, n] as const));

interface FakePanel {
  /** The list, in the panel's own order (insertion order: oldest first). */
  names: string[];
  /** name → creation time; a name created again gets a new one. */
  created: Map<string, number>;
  clock: number;
  log: ProviderHttpRequest[];
  beforePage: (offset: number, pageIndex: number) => void;
  pages: number;
  /** Rewrites a page's rows before they are sent (an order, a withheld row…). */
  view?: (rows: string[], offset: number, limit: number) => string[];
  /** Leaves `created_at` off every row. */
  noCreatedAt?: boolean;
  /** Sends this as every row's `created_at` instead (a malformed or empty stamp). */
  createdAtAs?: string;
  /** A row's `status`, by name and the page it is served on (default `active`). */
  statusOf?: (username: string, pageIndex: number) => string;
  /** Leaves `total` off every page. */
  noTotal?: boolean;
  /** The panel's own page size: it serves at most this many rows whatever is asked. */
  cap?: number;
}

function fakePanel(count: number): FakePanel {
  const panel: FakePanel = {
    names: [],
    created: new Map(),
    clock: 0,
    log: [],
    beforePage: () => undefined,
    pages: 0,
  };
  for (let i = 1; i <= count; i += 1) add(panel, name(i));
  return panel;
}

/** A sale or a manual account: created now, so at the end of the panel's insertion order. */
function add(panel: FakePanel, username: string): void {
  panel.clock += 1;
  panel.created.set(username, panel.clock);
  panel.names.push(username);
}

/** An account created now but listed in the MIDDLE (a panel not in insertion order). */
function insertAt(panel: FakePanel, index: number, username: string): void {
  panel.clock += 1;
  panel.created.set(username, panel.clock);
  panel.names.splice(index, 0, username);
}

const iso = (t: number) => new Date(Date.UTC(2026, 0, 1) + t * 1000).toISOString();

function clientOf(panel: FakePanel): ProviderHttpClient {
  return {
    send: async (request) => {
      panel.log.push(request);
      if (request.method === 'POST') return answer(200, { access_token: 'token-1' });
      if (request.path.startsWith('api/user/')) return answer(500, { detail: 'not expected' });
      const query = new URLSearchParams(request.path.split('?')[1] ?? '');
      const offset = Number(query.get('offset'));
      const limit = Math.min(Number(query.get('limit')), panel.cap ?? Number.MAX_SAFE_INTEGER);
      panel.beforePage(offset, panel.pages);
      panel.pages += 1;
      const slice = panel.names.slice(offset, offset + limit);
      const rows = panel.view === undefined ? slice : panel.view(slice, offset, limit);
      const users = rows.map((username) => ({
        username,
        status: panel.statusOf?.(username, panel.pages - 1) ?? 'active',
        ...(panel.noCreatedAt === true
          ? {}
          : {
              created_at: panel.createdAtAs ?? iso(panel.created.get(username) ?? 0),
            }),
      }));
      return answer(200, panel.noTotal === true ? { users } : { users, total: panel.names.length });
    },
  };
}

function sourceOf(panel: FakePanel, options: Record<string, unknown> = {}, stamp = STAMP) {
  let now = 0;
  return new RickpanelInventorySource(
    {
      panel: async () => ({ baseUrl: 'https://panel.invalid', providerType: 'rickpanel' }),
      credentials: async () => ({ username: 'admin', password: 'synthetic', apiToken: null }),
      http: () => clientOf(panel),
    },
    {
      pageSize: 100,
      clock: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
      gate: new InProcessPanelReadGate(),
      targeted: true,
      ...options,
    },
    stamp,
  );
}

type Complete = Extract<LegacyInventoryRead, { ok: true; complete: true }>;
function complete(read: LegacyInventoryRead): Complete {
  if (!read.ok || !read.complete)
    throw new Error(`expected a complete read: ${JSON.stringify(read)}`);
  return read;
}

const lookups = (panel: FakePanel) => panel.log.filter((r) => r.path.startsWith('api/user/'));

/** A read that adopted nothing for `n`: the panel incomplete, or the name not decided as one. */
function neverAdopted(read: LegacyInventoryRead, n: string): void {
  if (!read.ok) return;
  if (!read.complete) {
    expect(read.reason).toBeDefined();
    return;
  }
  const spellings = read.index.usernames.get(n);
  expect(spellings === undefined || spellings.length !== 1).toBe(true);
  expect(read.resolution?.present ?? 0).toBe(0);
}

/** Deletes `count` accounts at the head of the list before the given page indexes. */
const bursts = (panel: FakePanel, pages: readonly number[], count = 15) => {
  panel.beforePage = (_offset, page) => {
    if (pages.includes(page)) panel.names.splice(0, count);
  };
};

/**
 * Also a sale during the third walk (page 9), so the last two walks are never one complete
 * snapshot and the per-name resolution is what decides.
 */
const sellDuringThirdWalk = (panel: FakePanel) => {
  const before = panel.beforePage;
  panel.beforePage = (offset, page) => {
    before(offset, page);
    if (page === 9) add(panel, 'zz-third-walk-sale');
  };
};

// 300 accounts at 100 a page, 90 per step: page indexes 0-3 are walk 1, 4-7 walk 2, 8-11 walk 3.

describe('a live panel that keeps selling: decided from a gap-free last walk, never looked up', () => {
  it('sales and a manual account appended mid-walk: TOTAL_CHANGED, every needed name decided, nothing else indexed, not one lookup', async () => {
    const panel = fakePanel(300);
    panel.beforePage = (_o, page) => {
      if (page === 1) add(panel, 'zz-manual');
      if (page === 5) add(panel, 'zz-sale');
    };
    const read = complete(
      await sourceOf(panel).read(SCOPE, 'p1', { needed: need([name(1), name(200), 'gone']) }),
    );
    expect(read.resolution).toMatchObject({
      mode: 'TARGETED',
      reason: 'TOTAL_CHANGED',
      needed: 3,
      present: 2,
      absent: 1,
      collisions: 0,
      unresolved: 0,
      walks: 2,
      gapFree: true,
    });
    expect(lookups(panel)).toEqual([]);
    expect(read.index.usernames.has('zz-manual')).toBe(false);
    expect(indexCovers(read.index, 'zz-manual')).toBe(false);
    expect(indexCovers(read.index, 'gone')).toBe(true);
    expect(read.index.usernames.has('gone')).toBe(false);
  });

  it('single deletions in both walks: still gap-free; a needed account deleted before its read is absent; one the next walk returns again is present', async () => {
    const panel = fakePanel(300);
    panel.beforePage = (_o, page) => {
      if (page === 1) panel.names.splice(panel.names.indexOf(name(7)), 1);
      if (page === 2) panel.names.splice(panel.names.indexOf(name(250)), 1);
      if (page === 6) panel.names.splice(0, 3);
    };
    const read = complete(
      await sourceOf(panel).read(SCOPE, 'p1', { needed: need([name(101), name(250)]) }),
    );
    // Decided as of the first walk's end; the second returns name(101) unchanged.
    expect(read.resolution).toMatchObject({ walks: 2, gapFree: true, present: 1, absent: 1 });
  });

  it('a burst in the first walk only: the second is gap-free and decides, confirmed by a third', async () => {
    const panel = fakePanel(300);
    bursts(panel, [1]);
    sellDuringThirdWalk(panel);
    const read = complete(
      await sourceOf(panel).read(SCOPE, 'p1', { needed: need([name(101), name(290)]) }),
    );
    expect(read.resolution).toMatchObject({ walks: 3, gapFree: true, present: 2, unresolved: 0 });
  });

  it('Codex: a burst in the first walk only, then a still panel — the last two walks are one complete snapshot, as of the second walk’s end', async () => {
    const panel = fakePanel(300);
    bursts(panel, [1]);
    let stamps = 0;
    const stamp = () => new Date(Date.UTC(2026, 9, 14, 8, 0, stamps++));
    const read = complete(
      await sourceOf(panel, {}, stamp).read(SCOPE, 'p1', {
        needed: need([name(101), name(5)]),
      }),
    );
    expect(read.resolution).toBeUndefined();
    expect(read.index.usernames.get(name(101))).toEqual([name(101)]);
    // name(5) was deleted by the burst before the second walk.
    expect(read.index.usernames.has(name(5))).toBe(false);
    expect(read.observedAt.toISOString()).toBe('2026-10-14T08:00:01.000Z');
  });

  it('bursts in both walks: the gap-free third has no walk after it to confirm it — UNRESOLVED', async () => {
    const panel = fakePanel(300);
    bursts(panel, [1, 5]);
    const read = complete(await sourceOf(panel).read(SCOPE, 'p1', { needed: need([name(290)]) }));
    expect(read.resolution).toMatchObject({ walks: 3, gapFree: false, present: 0, unresolved: 1 });
    neverAdopted(read, name(290));
  });

  it('bursts in every walk: at most three walks, then every name UNRESOLVED — never present, never absent', async () => {
    const panel = fakePanel(400);
    // 400 accounts: page indexes 1, 6, 11 fall inside walks 1, 2 and 3.
    bursts(panel, [1, 6, 11, 16], 12);
    const read = complete(
      await sourceOf(panel).read(SCOPE, 'p1', { needed: need([name(395), 'gone']) }),
    );
    expect(read.resolution).toMatchObject({
      walks: TARGETED_MAX_WALKS,
      gapFree: false,
      present: 0,
      absent: 0,
      unresolved: 2,
    });
    expect(indexCovers(read.index, name(395))).toBe(false);
    expect(indexCovers(read.index, 'gone')).toBe(false);
    expect(lookups(panel)).toEqual([]);
  });
});

describe('Codex P1: a needed row read, then deleted, during the decision walk', () => {
  // A stamp as each walk ends: index 0 is the first walk's end.
  const stamped = () => {
    let stamps = 0;
    return () => new Date(Date.UTC(2026, 9, 14, 8, 0, stamps++));
  };
  const FIRST_END = '2026-10-14T08:00:00.000Z';

  it('deleted behind the cursor after its read: the next walk does not return it — ABSENT, never present', async () => {
    const panel = fakePanel(300);
    // Page 1 is the first walk's second page: name(5), read on page 0, is deleted behind it.
    panel.beforePage = (_o, page) => {
      if (page === 1) panel.names.splice(panel.names.indexOf(name(5)), 1);
    };
    const read = complete(await sourceOf(panel).read(SCOPE, 'p1', { needed: need([name(5)]) }));
    expect(read.resolution).toMatchObject({ walks: 2, gapFree: true, present: 0, absent: 1 });
    expect(read.index.usernames.has(name(5))).toBe(false);
    expect(indexCovers(read.index, name(5))).toBe(true);
    expect(lookups(panel)).toEqual([]);
  });

  it('deleted within the overlap after its read: ABSENT', async () => {
    const panel = fakePanel(300);
    panel.beforePage = (_o, page) => {
      if (page === 1) panel.names.splice(panel.names.indexOf(name(95)), 1);
    };
    const read = complete(await sourceOf(panel).read(SCOPE, 'p1', { needed: need([name(95)]) }));
    expect(read.resolution).toMatchObject({ walks: 2, present: 0, absent: 1 });
  });

  it('reviewer F1: deleted behind the cursor while an account is listed at the head — nothing inside the walk shows it: never present', async () => {
    const panel = fakePanel(300);
    panel.beforePage = (_o, page) => {
      if (page === 1) {
        panel.names.splice(panel.names.indexOf(name(5)), 1);
        insertAt(panel, 0, 'aa-head');
      }
    };
    const read = await sourceOf(panel).read(SCOPE, 'p1', { needed: need([name(5)]) });
    neverAdopted(read, name(5));
    if (read.ok && read.complete) expect(read.resolution?.present ?? 0).toBe(0);
  });

  it('reviewer F3: a tie reordered masks a deletion — the deleted row is never present, the surviving one never absent', async () => {
    const panel = fakePanel(300);
    const tie = panel.created.get(name(86)) as number;
    for (let i = 86; i <= 96; i += 1) panel.created.set(name(i), tie);
    panel.beforePage = (_o, page) => {
      if (page === 1) {
        panel.names.splice(panel.names.indexOf(name(96)), 1);
        panel.names.splice(panel.names.indexOf(name(86)), 0, name(96));
        panel.names.splice(panel.names.indexOf(name(5)), 1);
      }
    };
    sellDuringThirdWalk(panel);
    const read = complete(
      await sourceOf(panel).read(SCOPE, 'p1', { needed: need([name(5), name(96)]) }),
    );
    expect(read.index.usernames.get(name(5))).toBeUndefined();
    expect(read.index.usernames.get(name(96))).toEqual([name(96)]);
    expect(read.resolution).toMatchObject({ present: 1, absent: 1, unresolved: 0 });
  });

  it('read, then deleted during a LATER walk: present as of the decision walk’s end, which the later walk confirms', async () => {
    const panel = fakePanel(300);
    panel.beforePage = (_o, page) => {
      if (page === 1) add(panel, 'zz-sale');
      // Page 5: the second walk's second page; name(5) was read on page 4, before it.
      if (page === 5) {
        panel.names.splice(panel.names.indexOf(name(5)), 1);
        insertAt(panel, 0, 'aa-head');
      }
    };
    const read = complete(
      await sourceOf(panel, {}, stamped()).read(SCOPE, 'p1', { needed: need([name(5)]) }),
    );
    expect(read.resolution).toMatchObject({ present: 1, gapFree: true });
    expect(read.observedAt.toISOString()).toBe(FIRST_END);
  });

  it('reviewer F1b: two consistent, identical walks — one complete snapshot as of the FIRST walk’s end', async () => {
    const panel = fakePanel(300);
    panel.beforePage = (_o, page) => {
      if (page === 5) {
        panel.names.splice(panel.names.indexOf(name(5)), 1);
        insertAt(panel, 0, 'aa-head');
      }
    };
    const read = complete(
      await sourceOf(panel, {}, stamped()).read(SCOPE, 'p1', { needed: need([name(5)]) }),
    );
    expect(read.resolution).toBeUndefined();
    expect(read.index.usernames.get(name(5))).toEqual([name(5)]);
    expect(read.observedAt.toISOString()).toBe(FIRST_END);
  });

  it('the snapshot shortcut needs the SAME rows: a name deleted and created again between the walks is not one snapshot', async () => {
    const panel = fakePanel(300);
    panel.beforePage = (_o, page) => {
      if (page === 4) {
        // Between the walks: name(300) deleted and created again (a new creation time) — the
        // two walks list the same names and the same total.
        panel.names.splice(panel.names.indexOf(name(300)), 1);
        add(panel, name(300));
      }
    };
    const read = complete(await sourceOf(panel).read(SCOPE, 'p1', { needed: need([name(300)]) }));
    expect(read.resolution).toBeDefined();
    // The second walk would decide, confirmed by a third — but the first saw that name as
    // ANOTHER account (another creation time): which one the backup meant is not a guess.
    expect(read.resolution).toMatchObject({ walks: 3, present: 0, unresolved: 1 });
    expect(indexCovers(read.index, name(300))).toBe(false);
  });

  it('another row deleted behind the cursor in every walk: the needed row is confirmed by the next walk returning it — PRESENT', async () => {
    const panel = fakePanel(300);
    panel.beforePage = (_o, page) => {
      if (page === 1 || page === 5 || page === 9) panel.names.splice(1, 1);
    };
    const read = complete(await sourceOf(panel).read(SCOPE, 'p1', { needed: need([name(5)]) }));
    expect(read.resolution).toMatchObject({ gapFree: true, present: 1, unresolved: 0 });
    expect(read.index.usernames.get(name(5))).toEqual([name(5)]);
  });

  it('deleted and created again under the same name: a new creation time confirms nothing — UNRESOLVED, never attached', async () => {
    const panel = fakePanel(300);
    panel.beforePage = (_o, page) => {
      // Before the second walk: name(5) deleted and created again — another account.
      if (page === 4) {
        panel.names.splice(panel.names.indexOf(name(5)), 1);
        add(panel, name(5));
      }
      // Bursts break the second and third walks: only the first can decide.
      if (page === 5 || page === 9) panel.names.splice(20, 15);
    };
    const read = complete(await sourceOf(panel).read(SCOPE, 'p1', { needed: need([name(5)]) }));
    expect(read.resolution).toMatchObject({ walks: 3, present: 0, absent: 0, unresolved: 1 });
    expect(indexCovers(read.index, name(5))).toBe(false);
    neverAdopted(read, name(5));
  });

  it('read, deleted, and no later gap-free walk to show it gone: UNRESOLVED, never present', async () => {
    const panel = fakePanel(300);
    panel.beforePage = (_o, page) => {
      if (page === 1) panel.names.splice(panel.names.indexOf(name(5)), 1);
      if (page === 5 || page === 9) panel.names.splice(20, 15);
    };
    const read = complete(await sourceOf(panel).read(SCOPE, 'p1', { needed: need([name(5)]) }));
    expect(read.resolution).toMatchObject({ walks: 3, present: 0, absent: 0, unresolved: 1 });
    neverAdopted(read, name(5));
  });
});

describe('second review: a name re-created as another account, and the cap', () => {
  const recreate = (panel: FakePanel, n: string) => {
    panel.names.splice(panel.names.indexOf(n), 1);
    add(panel, n);
  };

  it('R1: a later walk confirms the old row, a gap-free walk after it shows a NEW row under the name: UNRESOLVED, never attached', async () => {
    const panel = fakePanel(300);
    panel.beforePage = (_o, page) => {
      if (page === 6) panel.names.splice(0, 15);
      if (page === 8) recreate(panel, name(50));
    };
    const read = complete(
      await sourceOf(panel).read(SCOPE, 'p1', { needed: need([name(50), name(200)]) }),
    );
    expect(read.resolution?.walks).toBe(3);
    expect(read.index.usernames.get(name(50))).toBeUndefined();
    expect(indexCovers(read.index, name(50))).toBe(false);
    // The re-created row moved name(50) in the list: the third walk's order disagrees with the
    // second's, so it is not decisive and nothing is present on one spelling.
    expect(read.resolution?.present).toBe(0);
  });

  it('R2: re-created while the second walk read it (that walk lists the old row and the new): not one snapshot, never attached', async () => {
    const panel = fakePanel(300);
    panel.beforePage = (_o, page) => {
      if (page === 5) recreate(panel, name(50));
    };
    const read = complete(
      await sourceOf(panel).read(SCOPE, 'p1', { needed: need([name(50), name(200)]) }),
    );
    expect(read.index.usernames.get(name(50))).toBeUndefined();
    expect(indexCovers(read.index, name(50))).toBe(false);
  });

  it('R3: the cap reached with the last walk broken — a variant that walk may have skipped exists: nothing PRESENT on one spelling', async () => {
    const panel = fakePanel(300);
    panel.beforePage = (_o, page) => {
      if (page === 6) panel.names.splice(0, 15);
      if (page === 10) add(panel, 'ACC00050');
      if (page === 11) panel.names.splice(0, 20);
    };
    const read = complete(
      await sourceOf(panel).read(SCOPE, 'p1', { needed: need([name(50), name(200)]) }),
    );
    expect(panel.names).toContain('ACC00050');
    expect(read.resolution).toMatchObject({ walks: 3, present: 0 });
    expect(read.index.usernames.get(name(50))).toBeUndefined();
    neverAdopted(read, name(50));
  });
});

describe('Codex review on f4bcdd62', () => {
  it('the last walk gap-free but in another order than the one before it: not decisive — nothing present on one spelling', async () => {
    const panel = fakePanel(300);
    // name(10) and name(11) share a creation time (a tie), so either order is oldest first.
    panel.created.set(name(11), panel.created.get(name(10)) as number);
    panel.beforePage = (_o, page) => {
      // Between the first and second walk a needed account is created: the first walk cannot
      // decide it, so a third walk is made after the (gap-free) second.
      if (page === 4) add(panel, 'zz-new');
    };
    panel.view = (rows) => {
      // The third walk (pages 8+) lists the tie the other way round.
      if (panel.pages <= 8) return rows;
      const i = rows.indexOf(name(10));
      const j = rows.indexOf(name(11));
      if (i < 0 || j < 0) return rows;
      const out = [...rows];
      out[i] = name(11);
      out[j] = name(10);
      return out;
    };
    sellDuringThirdWalk(panel);
    const read = complete(
      await sourceOf(panel).read(SCOPE, 'p1', { needed: need([name(200), 'zz-new']) }),
    );
    expect(read.resolution?.walks).toBe(3);
    expect(read.resolution?.present).toBe(0);
    expect(read.index.usernames.get(name(200))).toBeUndefined();
  });

  it('a still panel whose rows carry no created_at: never one complete snapshot — every name unresolved', async () => {
    const panel = fakePanel(300);
    panel.noCreatedAt = true;
    const read = complete(await sourceOf(panel).read(SCOPE, 'p1', { needed: need([name(5)]) }));
    expect(read.resolution).toMatchObject({ mode: 'TARGETED', present: 0, unresolved: 1 });
    expect(indexCovers(read.index, name(5))).toBe(false);
  });

  it('a COUNT_MISMATCH found on the third walk reports every walk made', async () => {
    const panel = fakePanel(300);
    bursts(panel, [1]);
    // The third walk withholds one row of its second page: fewer names than its total.
    panel.view = (rows, offset) =>
      panel.pages === 10 && offset > 0 ? rows.filter((r) => r !== name(150)) : rows;
    const read = await sourceOf(panel).read(SCOPE, 'p1', { needed: need([name(5)]) });
    if (!read.ok || read.complete) throw new Error(`expected incomplete: ${JSON.stringify(read)}`);
    expect(read.reason).toBe('COUNT_MISMATCH');
    expect(read.diagnostics?.walks).toHaveLength(3);
  });
});

describe('Codex review on 79f46fda', () => {
  it('a still panel whose rows carry a malformed created_at: never one complete snapshot', async () => {
    for (const stamp of ['', 'not-a-date']) {
      const panel = fakePanel(300);
      panel.createdAtAs = stamp;
      const read = complete(await sourceOf(panel).read(SCOPE, 'p1', { needed: need([name(5)]) }));
      expect(read.resolution, stamp).toMatchObject({
        mode: 'TARGETED',
        reason: 'NO_CREATION_TIME',
        present: 0,
      });
      expect(indexCovers(read.index, name(5))).toBe(false);
    }
  });

  it('the cap reached with the last walk broken: a name the decision walk lacked is not ABSENT either', async () => {
    const panel = fakePanel(300);
    // The first walk is gap-free and decides; the second and third are broken by bursts.
    panel.beforePage = (_o, page) => {
      if (page === 5 || page === 9) panel.names.splice(20, 15);
    };
    const read = complete(await sourceOf(panel).read(SCOPE, 'p1', { needed: need(['nobody']) }));
    expect(read.resolution).toMatchObject({ walks: 3, absent: 0, unresolved: 1 });
    expect(indexCovers(read.index, 'nobody')).toBe(false);
  });

  it('Codex: no total and a server cap below the page asked for — the walk keeps paging, never stops at the first page', async () => {
    const panel = fakePanel(300);
    panel.noTotal = true;
    panel.cap = 50;
    const read = await sourceOf(panel).read(SCOPE, 'p1', { needed: need([name(250)]) });
    // Never a wrong ABSENT for an account past the first page: either it is read, or undecided.
    if (read.ok && read.complete && indexCovers(read.index, name(250))) {
      expect(read.index.usernames.get(name(250))).toEqual([name(250)]);
    }
    // The walk went past the first capped page.
    expect(panel.log.filter((r) => r.method !== 'POST').length).toBeGreaterThan(2);
  });

  it('Codex: no total, a cap, and a panel that ignores offset — NO_PROGRESS on the second page, never a page loop', async () => {
    const panel = fakePanel(300);
    panel.noTotal = true;
    panel.cap = 50;
    panel.view = (rows) => panel.names.slice(0, rows.length); // offset ignored
    const read = await sourceOf(panel).read(SCOPE, 'p1', { needed: need([name(250)]) });
    expect(read.ok).toBe(false);
    // A handful of requests, never the page limit.
    expect(panel.log.length).toBeLessThan(10);
  });

  it('Codex: page size 1 (no overlap possible) — a still panel is still one complete snapshot, never three walks of nothing', async () => {
    const panel = fakePanel(5);
    const read = complete(
      await sourceOf(panel, { pageSize: 1 }).read(SCOPE, 'p1', { needed: need([name(3)]) }),
    );
    expect(read.resolution).toBeUndefined();
    expect(read.index.usernames.get(name(3))).toEqual([name(3)]);
  });

  it('two walks that share no row prove no common order', () => {
    expect(sameRelativeOrder(['a', 'b'], ['c', 'd'])).toBe(false);
    expect(sameRelativeOrder([], [])).toBe(true);
    expect(sameRelativeOrder(['a', 'b', 'x'], ['a', 'y', 'b'])).toBe(true);
    expect(sameRelativeOrder(['a', 'b'], ['b', 'a'])).toBe(false);
    // One shared row orders nothing.
    expect(sameRelativeOrder(['a', 'x', 'y'], ['a', 'p', 'q'])).toBe(false);
    expect(sameRelativeOrder(['a'], ['a'])).toBe(true);
  });

  it('Codex: a row an overlap repeats within one walk reports the facts of its LATER read', async () => {
    const panel = fakePanel(300);
    // name(95) is on page 4 and again on page 5 (the overlap); it is disabled in between.
    panel.statusOf = (n, page) => (n === name(95) && page >= 5 ? 'disabled' : 'active');
    const read = complete(await sourceOf(panel).read(SCOPE, 'p1', { needed: need([name(95)]) }));
    expect(read.runtime.get(name(95))?.state).toBe('disabled');
  });

  it('the snapshot shortcut, too: the same rows, their runtime facts as the second walk read them', async () => {
    const panel = fakePanel(300);
    panel.statusOf = (n, page) => (n === name(5) && page >= 4 ? 'disabled' : 'active');
    const read = complete(await sourceOf(panel).read(SCOPE, 'p1', { needed: need([name(5)]) }));
    expect(read.resolution).toBeUndefined();
    expect(read.runtime.get(name(5))?.state).toBe('disabled');
  });

  it('runtime facts of a present account come from the latest walk that returned the same row', async () => {
    const panel = fakePanel(300);
    panel.beforePage = (_o, page) => {
      if (page === 1) add(panel, 'zz-sale');
    };
    // The second walk (pages 4+) finds name(5) disabled: the current state, not the first's.
    panel.statusOf = (n, page) => (n === name(5) && page >= 4 ? 'disabled' : 'active');
    const read = complete(await sourceOf(panel).read(SCOPE, 'p1', { needed: need([name(5)]) }));
    expect(read.resolution).toMatchObject({ walks: 2, present: 1 });
    expect(read.runtime.get(name(5))?.state).toBe('disabled');
  });
});

describe('case variants: a collision or unresolved, never an adoption', () => {
  it('a variant on the panel (ALICE beside the backup alice): COLLISION, both spellings indexed', async () => {
    const panel = fakePanel(300);
    add(panel, 'alice');
    add(panel, 'ALICE');
    bursts(panel, [1]);
    sellDuringThirdWalk(panel);
    const read = complete(await sourceOf(panel).read(SCOPE, 'p1', { needed: need(['alice']) }));
    expect(read.index.usernames.get('alice')).toEqual(['ALICE', 'alice']);
    expect(read.resolution).toMatchObject({ collisions: 1, present: 0 });
  });

  it('Codex P1: ALICE created behind the second walk’s cursor — the insertion is detected, a third walk sees it: COLLISION, never alice alone', async () => {
    const panel = fakePanel(300);
    add(panel, 'alice');
    panel.beforePage = (_o, page) => {
      if (page === 1) add(panel, 'zz-sale'); // churn: not one snapshot
      if (page === 6) insertAt(panel, 10, 'ALICE'); // behind walk 2's cursor
    };
    const read = complete(await sourceOf(panel).read(SCOPE, 'p1', { needed: need(['alice']) }));
    expect(read.index.usernames.get('alice')).not.toEqual(['alice']);
    expect(read.resolution?.present).toBe(0);
  });

  it('a variant hidden by an order that depends on the offset (reviewer F1): never gap-free, UNRESOLVED', async () => {
    const panel = fakePanel(0);
    add(panel, 'alice');
    for (let i = 1; i <= 99; i += 1) add(panel, name(i));
    add(panel, 'ALICE');
    for (let i = 100; i <= 250; i += 1) add(panel, name(i));
    panel.beforePage = (_o, page) => {
      if (page === 1 || page === 4) add(panel, `zz-sale-${String(page)}`);
    };
    // A deterministic order that differs by offset: past the first page, ALICE is listed first.
    panel.view = (_rows, offset, limit) => {
      const order =
        offset === 0 ? panel.names : ['ALICE', ...panel.names.filter((n) => n !== 'ALICE')];
      return order.slice(offset, offset + limit);
    };
    neverAdopted(await sourceOf(panel).read(SCOPE, 'p1', { needed: need(['alice']) }), 'alice');
  });

  it('a variant withheld from the first page, mistaken for a page-size cap (reviewer F2): never gap-free', async () => {
    const panel = fakePanel(0);
    add(panel, 'alice');
    for (let i = 1; i <= 4; i += 1) add(panel, name(i));
    add(panel, 'ALICE');
    for (let i = 5; i <= 250; i += 1) add(panel, name(i));
    panel.beforePage = (_o, page) => {
      if (page === 1 || page === 4) add(panel, `zz-sale-${String(page)}`);
    };
    panel.view = (rows) => rows.filter((n) => n !== 'ALICE');
    neverAdopted(await sourceOf(panel).read(SCOPE, 'p1', { needed: need(['alice']) }), 'alice');
  });

  it('rows without created_at: the order cannot be verified, so nothing is decided', async () => {
    const panel = fakePanel(300);
    panel.noCreatedAt = true;
    panel.beforePage = (_o, page) => {
      if (page === 1) add(panel, 'zz-sale');
    };
    const read = complete(
      await sourceOf(panel).read(SCOPE, 'p1', { needed: need([name(5), 'gone']) }),
    );
    expect(read.resolution).toMatchObject({ gapFree: false, present: 0, absent: 0, unresolved: 2 });
  });

  it('an order that is not stable between requests: never gap-free, nothing decided', async () => {
    const panel = fakePanel(300);
    panel.beforePage = (_o, page) => {
      if (page === 1) add(panel, 'zz-sale');
      const head = panel.names.slice(0, 60);
      panel.names = [...head.slice(1), ...head.slice(0, 1), ...panel.names.slice(60)];
    };
    sellDuringThirdWalk(panel);
    const read = complete(
      await sourceOf(panel).read(SCOPE, 'p1', { needed: need([name(150), 'gone']) }),
    );
    expect(read.resolution).toMatchObject({ present: 0, absent: 0, unresolved: 2 });
  });

  it('a name the backup spells two ways: UNRESOLVED even on a gap-free walk', async () => {
    const panel = fakePanel(300);
    panel.beforePage = (_o, page) => {
      if (page === 1) add(panel, 'zz-sale');
    };
    const read = complete(
      await sourceOf(panel).read(SCOPE, 'p1', { needed: new Map([[name(5), null]]) }),
    );
    expect(read.resolution).toMatchObject({ gapFree: true, unresolved: 1 });
  });
});

describe('second review: a row returned again in another account’s place', () => {
  /** alice, then 299 accounts with ALICE at `variantAt`, all in insertion order. */
  function build(variantAt: number, sameSecond = false): FakePanel {
    const panel = fakePanel(0);
    add(panel, 'alice');
    for (let i = 1; i < variantAt; i += 1) add(panel, name(i));
    add(panel, 'ALICE');
    for (let i = variantAt; i <= 299; i += 1) add(panel, name(i));
    if (sameSecond) for (const n of panel.names) panel.created.set(n, 1);
    return panel;
  }
  const selling = (panel: FakePanel) => {
    panel.beforePage = (_o, page) => {
      if (page % 4 === 1) add(panel, `zz-sale-${String(page)}`);
    };
  };

  it('ALICE replaced on one page by a row already seen (a tied ORDER BY): never alice alone (F-A)', async () => {
    const panel = build(250);
    selling(panel);
    panel.view = (rows, offset) =>
      offset === 180 ? rows.map((n) => (n === 'ALICE' ? name(5) : n)) : rows;
    neverAdopted(await sourceOf(panel).read(SCOPE, 'p1', { needed: need(['alice']) }), 'alice');
  });

  it('the same with every created_at equal (a bulk import): never alice alone (F-A, E)', async () => {
    const panel = build(250, true);
    selling(panel);
    panel.view = (rows, offset) =>
      offset === 180 ? rows.map((n) => (n === 'ALICE' ? name(5) : n)) : rows;
    neverAdopted(await sourceOf(panel).read(SCOPE, 'p1', { needed: need(['alice']) }), 'alice');
  });

  it('a needed account replaced by a row already seen: never a wrong ABSENT (F-A, B2)', async () => {
    const panel = build(250);
    selling(panel);
    panel.view = (rows, offset) =>
      offset === 180 ? rows.map((n) => (n === name(240) ? name(5) : n)) : rows;
    const read = await sourceOf(panel).read(SCOPE, 'p1', { needed: need([name(240)]) });
    if (read.ok && read.complete) expect(read.resolution?.absent ?? 0).toBe(0);
  });

  it('a row withheld from a middle page ends the walk short of its total: never a wrong ABSENT (F-B)', async () => {
    const panel = build(150);
    panel.beforePage = (_o, page) => add(panel, `zz-sale-${String(page)}`);
    panel.view = (rows) => rows.filter((n) => n !== 'ALICE');
    const read = await sourceOf(panel).read(SCOPE, 'p1', { needed: need([name(280)]) });
    if (read.ok && read.complete) expect(read.resolution).toMatchObject({ absent: 0 });
  });
});

describe('a list that does not add up to its total', () => {
  it('fewer distinct names than a total that held still (a withheld row): the panel stays incomplete', async () => {
    const panel = fakePanel(150);
    add(panel, 'ACC00005');
    panel.view = (rows) => rows.filter((n) => n !== 'ACC00005');
    const read = await sourceOf(panel).read(SCOPE, 'p1', { needed: need([name(5)]) });
    expect(read).toMatchObject({ ok: true, complete: false, reason: 'COUNT_MISMATCH' });
  });

  it('more names than the total (a sale and a deletion in one interval — ordinary selling): not blocking', async () => {
    const panel = fakePanel(300);
    panel.beforePage = (_o, page) => {
      if (page === 2) {
        panel.names.splice(panel.names.indexOf(name(3)), 1);
        add(panel, 'zz-sale');
      }
    };
    const read = complete(await sourceOf(panel).read(SCOPE, 'p1', { needed: need([name(250)]) }));
    expect(read.resolution).toMatchObject({ gapFree: true, present: 1 });
  });
});

describe('the targeted read changes nothing it does not need to', () => {
  it('a panel that holds still: the ordinary complete read — whole index, no resolution', async () => {
    const panel = fakePanel(250);
    const read = complete(await sourceOf(panel).read(SCOPE, 'p1', { needed: need([name(3)]) }));
    expect(read.resolution).toBeUndefined();
    expect(read.index.covered).toBeUndefined();
    expect(read.index.usernames.size).toBe(250);
  });

  it('a source not built targeted (CLI, rehearsal) ignores `needed`: TOTAL_CHANGED stays incomplete', async () => {
    const panel = fakePanel(300);
    panel.beforePage = (_o, page) => {
      if (page === 1) add(panel, 'zz-manual');
    };
    const read = await sourceOf(panel, { targeted: false }).read(SCOPE, 'p1', {
      needed: need([name(1)]),
    });
    expect(read.ok && read.complete).toBe(false);
  });

  it('runtime facts come from the decision walk and are stamped when it ended', async () => {
    const panel = fakePanel(300);
    bursts(panel, [1]);
    sellDuringThirdWalk(panel);
    let stamps = 0;
    const stamp = () => new Date(Date.UTC(2026, 9, 14, 8, 0, stamps++));
    const read = complete(
      await sourceOf(panel, {}, stamp).read(SCOPE, 'p1', { needed: need([name(290)]) }),
    );
    expect(read.resolution?.walks).toBe(3);
    expect(read.runtime.has(name(290))).toBe(true);
    // One stamp as each walk ends; the second walk decided (the third confirmed it).
    expect(read.observedAt.toISOString()).toBe('2026-10-14T08:00:01.000Z');
  });
});

describe('decideNeededNames', () => {
  const acc = (u: string) => ({ username: u.toLowerCase(), providerUsername: u });
  const walk = (names: string[], created: Record<string, string[]> = {}, decisive = true) => ({
    accounts: names.map(acc),
    createdAt: new Map(names.map((n) => [n, new Set(created[n] ?? ['t0'])])),
    decisive,
  });
  it('present only when a later walk returns the same row; collision from any walk', () => {
    const walks = [
      walk(['a', 'B', 'e', 'f', 'g']),
      walk(['a', 'b', 'f', 'g'], { f: ['t1'], g: ['t0', 't1'] }),
    ];
    const out = decideNeededNames(
      new Map<string, string | null>([
        ['a', 'a'],
        ['b', 'b'],
        ['c', 'c'],
        ['d', null],
        ['e', 'e'],
        ['f', 'f'],
        ['g', 'g'],
      ]),
      walks,
      0,
    );
    expect(out.get('a')).toEqual({ kind: 'PRESENT', spelling: 'a' });
    expect(out.get('b')).toEqual({ kind: 'COLLISION', spellings: ['B', 'b'] });
    expect(out.get('c')).toEqual({ kind: 'ABSENT' });
    expect(out.get('d')).toEqual({ kind: 'UNRESOLVED' });
    // Read, not returned again, and the later gap-free walk shows no spelling of it: gone.
    expect(out.get('e')).toEqual({ kind: 'ABSENT' });
    // Returned again with another creation time: another account — undecided.
    expect(out.get('f')).toEqual({ kind: 'UNRESOLVED' });
    // Returned again — and also re-created: the name now holds another account. Undecided.
    expect(out.get('g')).toEqual({ kind: 'UNRESOLVED' });
    // An earlier walk saw the spelling with NO creation time: it may have been another account.
    const unstamped = decideNeededNames(
      need(['k']),
      [
        { accounts: [acc('k')], createdAt: new Map(), decisive: true },
        walk(['k'], { k: ['t1'] }),
        walk(['k'], { k: ['t1'] }),
      ],
      1,
    );
    expect(unstamped.get('k')).toEqual({ kind: 'UNRESOLVED' });
    // Re-created BEFORE the decision walk (an earlier walk saw another creation time): undecided.
    const before = decideNeededNames(
      need(['h']),
      [walk(['h'], { h: ['t0'] }), walk(['h'], { h: ['t1'] }), walk(['h'], { h: ['t1'] })],
      1,
    );
    expect(before.get('h')).toEqual({ kind: 'UNRESOLVED' });
  });
  it('not returned again, and no later gap-free walk: UNRESOLVED; absent in the decision walk but returned later: UNRESOLVED', () => {
    const out = decideNeededNames(need(['a', 'c']), [walk(['a']), walk(['c'], {}, false)], 0);
    expect(out.get('a')).toEqual({ kind: 'UNRESOLVED' });
    expect(out.get('c')).toEqual({ kind: 'UNRESOLVED' });
  });
  it('no decision walk: every name UNRESOLVED', () => {
    const blind = decideNeededNames(need(['a', 'c']), [walk(['a']), walk(['a'])], null);
    expect(blind.get('a')).toEqual({ kind: 'UNRESOLVED' });
    expect(blind.get('c')).toEqual({ kind: 'UNRESOLVED' });
  });
  it('another spelling than the backup’s, alone: the one account, as a complete read decides it', () => {
    const out = decideNeededNames(
      new Map([['alice', 'alice']]),
      [walk(['ALICE']), walk(['ALICE'])],
      0,
    );
    expect(out.get('alice')).toEqual({ kind: 'PRESENT', spelling: 'ALICE' });
  });
  it('refuses fewer than two walks, and a decision walk with none after it', () => {
    expect(() => decideNeededNames(need(['a']), [walk(['a'])], null)).toThrow();
    expect(() => decideNeededNames(need(['a']), [walk(['a']), walk(['a'])], 1)).toThrow();
  });
});

describe('the overlapping walk proves its own coverage', () => {
  const walkOf = async (panel: FakePanel, overlap = 10, pageSize = 100) => {
    const reader = new RickpanelInventoryReader();
    return reader.walk(
      {
        baseUrl: 'https://panel.invalid',
        credentials: { shape: 'USERNAME_PASSWORD', username: 'a', password: 'b' },
      } as never,
      readOnlyRickpanelHttp(clientOf(panel)),
      { pageSize, overlap },
    );
  };
  const gapFree = async (panel: FakePanel, overlap = 10) => {
    const walk = await walkOf(panel, overlap);
    if (!walk.ok) throw new Error(`walk: ${JSON.stringify(walk)}`);
    return walk.coverage?.gapFree;
  };

  it('a still panel: gap-free, pages step by limit − overlap', async () => {
    const panel = fakePanel(250);
    const walk = await walkOf(panel);
    if (!walk.ok) throw new Error('walk');
    expect(walk.coverage?.gapFree).toBe(true);
    expect(walk.coverage?.order).toHaveLength(250);
    expect(walk.evidence.pages).toBe(3);
  });

  it('up to 9 deletions ahead of the cursor between two pages: still gap-free; 15 break it', async () => {
    const a = fakePanel(250);
    a.beforePage = (_o, page) => {
      if (page === 1) a.names.splice(0, 9);
    };
    expect(await gapFree(a)).toBe(true);
    const b = fakePanel(250);
    b.beforePage = (_o, page) => {
      if (page === 1) b.names.splice(0, 15);
    };
    expect(await gapFree(b)).toBe(false);
  });

  it('an account created ahead of the cursor and not returned: not gap-free', async () => {
    const panel = fakePanel(250);
    panel.beforePage = (_o, page) => {
      if (page === 1) insertAt(panel, 5, 'zz-inserted');
    };
    expect(await gapFree(panel)).toBe(false);
  });

  it('a row deleted and created again under the same name does not chain a boundary (reviewer F4)', async () => {
    const panel = fakePanel(250);
    panel.beforePage = (_o, page) => {
      if (page === 1) {
        panel.names.splice(0, 12);
        panel.names.splice(panel.names.indexOf(name(100)), 1);
        add(panel, name(100));
      }
    };
    expect(await gapFree(panel)).toBe(false);
  });

  it('an empty page reached after a burst is never gap-free (reviewer K3)', async () => {
    const panel = fakePanel(110);
    panel.beforePage = (_o, page) => {
      if (page === 1) panel.names.splice(0, 20);
    };
    const walk = await walkOf(panel);
    if (!walk.ok) throw new Error('walk');
    expect(walk.coverage?.gapFree).toBe(false);
  });

  it('a panel ignoring offset: NO_PROGRESS, not 5 000 requests (reviewer K4)', async () => {
    const panel = fakePanel(250);
    panel.view = () => panel.names.slice(0, 100);
    const walk = await walkOf(panel);
    expect(walk).toMatchObject({ ok: false, pagination: 'NO_PROGRESS' });
  });

  it('a panel capping its pages at 50: the cap is learned, the overlap follows it, gap-free (reviewer K1, F5)', async () => {
    const panel = fakePanel(240);
    panel.view = (rows) => rows.slice(0, 50);
    const walk = await walkOf(panel);
    if (!walk.ok) throw new Error('walk');
    expect(walk.coverage?.gapFree).toBe(true);
    expect(walk.coverage?.order).toHaveLength(240);
    expect(walk.evidence.pages).toBeLessThanOrEqual(7); // 50 rows, 38-row steps
  });

  it('a cap of 20: the overlap follows it (5 rows), so pages step by 15, not 10 (reviewer F5)', async () => {
    const panel = fakePanel(240);
    panel.view = (rows) => rows.slice(0, 20);
    const walk = await walkOf(panel);
    if (!walk.ok) throw new Error('walk');
    expect(walk.coverage?.gapFree).toBe(true);
    expect(walk.coverage?.order).toHaveLength(240);
    expect(walk.evidence.pages).toBeLessThanOrEqual(17); // ⌈(240 − 20) / 15⌉ + 1
  });

  it('a row withheld from the first page shifts every later row: the boundary does not chain (reviewer F2)', async () => {
    const panel = fakePanel(0);
    add(panel, 'alice');
    for (let i = 1; i <= 4; i += 1) add(panel, name(i));
    add(panel, 'ALICE');
    for (let i = 5; i <= 250; i += 1) add(panel, name(i));
    panel.view = (rows) => rows.filter((n) => n !== 'ALICE');
    expect(await gapFree(panel)).toBe(false);
  });

  it('two rows swapped inside the overlap: the chain’s order breaks (reviewer K8)', async () => {
    const panel = fakePanel(250);
    panel.beforePage = (_o, page) => {
      if (page === 1) {
        const [a, b] = [panel.names[92] as string, panel.names[95] as string];
        panel.names[92] = b;
        panel.names[95] = a;
      }
    };
    expect(await gapFree(panel)).toBe(false);
  });

  it('a row out of creation order: not gap-free', async () => {
    const panel = fakePanel(250);
    insertAt(panel, 50, 'zz-newest-in-the-middle');
    expect(await gapFree(panel)).toBe(false);
  });

  it('without `overlap` the walk is exactly as before: no coverage reported', async () => {
    const panel = fakePanel(250);
    const walk = await walkOf(panel, 0);
    if (!walk.ok) throw new Error('walk');
    expect(walk.coverage).toBeUndefined();
    expect(walk.evidence.pages).toBe(3);
  });

  it('sameRelativeOrder: common rows in one order, or not', () => {
    expect(sameRelativeOrder(['a', 'b', 'c'], ['a', 'x', 'b', 'c'])).toBe(true);
    expect(sameRelativeOrder(['a', 'b', 'c'], ['b', 'a', 'c'])).toBe(false);
    expect(sameRelativeOrder(undefined, ['a'])).toBe(false);
  });
});

describe('neededNamesByPanel — exactly what the backup can ask', () => {
  const policy = {
    knownPanels: new Map([
      ['code-a', 'panel-a'],
      ['code-b', 'panel-b'],
    ]),
    testPanels: new Set(['code-test']),
    missingPanels: new Set(['code-gone']),
    productionPanelIds: ['panel-a', 'panel-b'],
  };
  const invoice = (over: Partial<Record<string, string | null>>) => ({
    idInvoice: 'inv-1',
    idUser: 'u1',
    username: 'Alice',
    isTest: '0',
    codePanel: 'code-a',
    ...over,
  });
  const run = (invoices: ReturnType<typeof invoice>[], operator = new Map<string, string>()) =>
    neededNamesByPanel(
      invoices,
      new Set(['u1']),
      policy,
      operator,
      (raw) => (raw.trim() === '' ? null : raw.trim().toLowerCase()),
      (key) => key.startsWith('inv-'),
    );

  it('a live owned invoice asks its mapped panel, canonically', () => {
    const out = run([invoice({})]);
    expect([...(out.get('panel-a') ?? new Map()).keys()]).toEqual(['alice']);
    expect([...(out.get('panel-b') ?? new Map()).keys()]).toEqual([]);
  });

  it('asks nothing for an unowned, test, invalid-key, nameless or unmapped invoice', () => {
    const out = run([
      invoice({ idUser: 'stranger' }),
      invoice({ idUser: null }),
      invoice({ isTest: '1' }),
      invoice({ idInvoice: 'bogus' }),
      invoice({ username: '  ' }),
      invoice({ codePanel: 'code-unknown' }),
      invoice({ codePanel: 'code-test' }),
    ]);
    expect([...(out.get('panel-a') ?? new Map()).keys()]).toEqual([]);
    expect([...(out.get('panel-b') ?? new Map()).keys()]).toEqual([]);
  });

  it('Codex: a panel-less invoice without an ADOPT asks every production panel — its holders are what an operator may be offered', () => {
    const out = run([invoice({ codePanel: null }), invoice({ codePanel: '  ' })]);
    expect([...(out.get('panel-a') ?? new Map()).keys()]).toEqual(['alice']);
    expect([...(out.get('panel-b') ?? new Map()).keys()]).toEqual(['alice']);
  });

  it('a declared-missing code asks every production panel; an operator ADOPT asks its panel', () => {
    const out = run(
      [
        invoice({ codePanel: 'code-gone' }),
        invoice({ idInvoice: 'inv-2', username: 'bob', codePanel: null }),
      ],
      new Map([['inv-2', 'panel-b']]),
    );
    expect([...(out.get('panel-a') ?? new Map()).keys()]).toEqual(['alice']);
    expect([...(out.get('panel-b') ?? new Map()).keys()].sort()).toEqual(['alice', 'bob']);
  });
});

describe('Codex review on 00128603', () => {
  it('a panel the backup names nothing on needs no credential and never takes the read gate', async () => {
    let acquired = 0;
    const source = new RickpanelInventorySource(
      {
        panel: async () => ({ baseUrl: 'https://panel.invalid', providerType: 'rickpanel' }),
        credentials: async () => null as never,
        http: () => {
          throw new Error('no client may be built');
        },
      },
      {
        pageSize: 100,
        clock: () => 0,
        sleep: async () => undefined,
        gate: {
          acquire: async () => {
            acquired += 1;
            throw new Error('the gate must not be taken');
          },
        } as never,
        targeted: true,
      },
      STAMP,
    );
    const read = complete(await source.read(SCOPE, 'p1', { needed: new Map() }));
    expect(read.resolution).toMatchObject({ reason: 'NOTHING_NEEDED', needed: 0 });
    expect(acquired).toBe(0);
  });
});

describe('reporting and the plan summary', () => {
  it('a panel the backup asks nothing of is not reported as churn', () => {
    const report = {
      verdict: 'DRY_RUN',
      sections: {
        provider: {
          panels: [
            {
              complete: true,
              reason: null,
              resolution: {
                mode: 'TARGETED',
                reason: 'NOTHING_NEEDED',
                needed: 0,
                unresolved: 0,
                walks: 0,
                gapFree: false,
              },
            },
          ],
        },
      },
    } as never;
    expect(providerChurnWarnings(report)).toEqual([]);
    expect(providerIncomplete(report)).toBe(0);
  });

  describe('a read that left needed names unresolved is not a complete panel', () => {
    const TENANT = '11111111-1111-4111-8111-111111111111';
    const PANEL_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const PANEL_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    async function planWith(inventories: ReadonlyMap<string, LegacyInventoryRead>) {
      const connector = new FixtureLegacySourceConnector(buildSyntheticLegacyDataset() as never);
      const snapshot = await readFromSession(connector.label, await connector.open());
      const mapping = parsePanelMapping(syntheticMappingFile(TENANT, PANEL_A, PANEL_B), TENANT);
      const plan = planLegacyImport({
        snapshot,
        mapping,
        salesCurrency: 'IRT',
        existingCustomers: new Map(),
        existingOpenings: new Map(),
        trialOverrides: new Map(),
        trialDecided: new Set(),
        existingShapes: new Map(),
        tariffCandidates: [],
        inventories,
      } as never);
      return { plan, snapshot };
    }
    const withResolution = (unresolved: number) => {
      const inventories = syntheticInventories(PANEL_A, PANEL_B);
      const a = inventories.get(PANEL_A);
      if (a === undefined || !a.ok || !a.complete) throw new Error('fixture');
      inventories.set(PANEL_A, {
        ...a,
        resolution: {
          mode: 'TARGETED',
          reason: 'TOTAL_CHANGED',
          needed: 5,
          present: 5 - unresolved,
          absent: 0,
          collisions: 0,
          unresolved,
          walks: 2,
          gapFree: unresolved === 0,
        },
      });
      return inventories;
    };

    it('unresolved > 0: the summary is complete:false, reason UNRESOLVED; resolved: complete', async () => {
      const blocked = (await planWith(withResolution(2))).plan.inventories.find(
        (p) => p.panelId === PANEL_A,
      );
      expect(blocked).toMatchObject({ complete: false, reason: 'UNRESOLVED' });
      expect(blocked?.resolution?.unresolved).toBe(2);
      const fine = (await planWith(withResolution(0))).plan.inventories.find(
        (p) => p.panelId === PANEL_A,
      );
      expect(fine).toMatchObject({ complete: true, reason: null, accounts: null, states: {} });
    });

    it('the services the partial index covers are still decided from it', async () => {
      const a = await planWith(withResolution(2));
      const b = await planWith(withResolution(0));
      expect(a.plan.services.length).toBe(b.plan.services.length);
      expect(a.plan.services.some((x) => x.decision.category === 'ADOPTION_ELIGIBLE')).toBe(true);
      expect(a.plan.services.map((x) => x.decision.category)).toEqual(
        b.plan.services.map((x) => x.decision.category),
      );
    });

    it("importableLegacyUserIds is exactly the plan's importable owners", async () => {
      const { plan, snapshot } = await planWith(syntheticInventories(PANEL_A, PANEL_B));
      const fromPlan = new Set(
        plan.users
          .filter(
            (u) => u.decision.kind !== 'INVALID_IDENTITY' && u.decision.kind !== 'MANUAL_REVIEW',
          )
          .map((u) => u.row.id),
      );
      expect(importableLegacyUserIds(snapshot.users, new Map())).toEqual(fromPlan);
      expect(fromPlan.size).toBeGreaterThan(0);
      expect(fromPlan.size).toBeLessThan(snapshot.users.length);
    });
  });
});

describe('a panel never read records no observation', () => {
  it('observedAtFor records no observation for a panel that was never read', () => {
    const notRead = new Map<string, LegacyInventoryRead>([
      [
        'p1',
        {
          ok: true,
          complete: true,
          index: { panelId: 'p1', usernames: new Map(), covered: new Set() },
          accounts: 0,
          states: {},
          runtime: new Map(),
          observedAt: new Date('2026-10-14T08:00:00Z'),
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
        },
      ],
    ]);
    expect(observedAtFor('p1', notRead)).toBeNull();
  });
});
