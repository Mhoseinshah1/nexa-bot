import { describe, expect, it } from 'vitest';
import type { ProviderHttpClient, ProviderHttpRequest, ProviderHttpResult } from '@nexa/contracts';
import { RickpanelInventorySource } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/rickpanel-inventory-source';
import { InProcessPanelReadGate } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/panel-read-gate';
import {
  classifyNeededNames,
  neededNamesByPanel,
  resolveLookup,
} from '../../apps/api/src/modules/platform/legacy-importer/application/inventory-resolution';
import { indexCovers } from '../../apps/api/src/modules/platform/legacy-import/application/legacy-service-matching';
import type { LegacyInventoryRead } from '../../apps/api/src/modules/platform/legacy-importer/application/ports';

/**
 * Per-name inventory resolution (`docs/rickpanel-inventory.md` §Per-name resolution): the owner
 * keeps Mirza selling while a dry run reads the live RickPanel, so `TOTAL_CHANGED` is the normal
 * case. Only the names the backup needs are decided; a manual account or a new sale is never
 * looked up, indexed or counted; what evidence cannot decide stays UNRESOLVED (uncovered), which
 * the matcher keeps undecidable. SYNTHETIC data, fake panels only.
 */

const SCOPE = { tenantId: '11111111-1111-4111-8111-111111111111' } as never;
const STAMP = () => new Date('2026-10-14T08:00:00.000Z');

const answer = (status: number, body: unknown) =>
  ({ ok: true, status, headers: {}, bodyText: JSON.stringify(body), setCookie: [] }) as const;

const name = (i: number) => `acc${String(i).padStart(5, '0')}`;

interface FakePanel {
  names: string[];
  log: ProviderHttpRequest[];
  /** Before each list page is served (walk-relative page count is the caller's business). */
  beforePage: (offset: number, pageIndex: number) => void;
  /** Answers a lookup in the panel's place. */
  onLookup: (username: string) => ProviderHttpResult | undefined;
  pages: number;
}

function fakePanel(count: number): FakePanel {
  return {
    names: Array.from({ length: count }, (_, i) => name(i + 1)),
    log: [],
    beforePage: () => undefined,
    onLookup: () => undefined,
    pages: 0,
  };
}

function clientOf(panel: FakePanel): ProviderHttpClient {
  return {
    send: async (request) => {
      panel.log.push(request);
      if (request.method === 'POST') return answer(200, { access_token: 'token-1' });
      if (request.path.startsWith('api/user/')) {
        const username = decodeURIComponent(request.path.slice('api/user/'.length));
        const instead = panel.onLookup(username);
        if (instead !== undefined) return instead;
        return panel.names.includes(username)
          ? answer(200, { username, status: 'active' })
          : answer(404, { detail: 'User not found' });
      }
      const query = new URLSearchParams(request.path.split('?')[1] ?? '');
      const offset = Number(query.get('offset'));
      const limit = Number(query.get('limit'));
      panel.beforePage(offset, panel.pages);
      panel.pages += 1;
      const users = panel.names
        .slice(offset, offset + limit)
        .map((username) => ({ username, status: 'active' }));
      return answer(200, { users, total: panel.names.length });
    },
  };
}

function sourceOf(panel: FakePanel, options: Record<string, unknown> = {}) {
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
    STAMP,
  );
}

type Complete = Extract<LegacyInventoryRead, { ok: true; complete: true }>;
function complete(read: LegacyInventoryRead): Complete {
  if (!read.ok || !read.complete)
    throw new Error(`expected a complete read: ${JSON.stringify(read)}`);
  return read;
}

const lookups = (panel: FakePanel) =>
  panel.log.filter((r) => r.path.startsWith('api/user/')).map((r) => r.path.slice(9));

describe('a live panel that keeps selling during the dry run', () => {
  it('TOTAL_CHANGED from a manual account added mid-walk: every needed name decided, the manual account never asked or indexed', async () => {
    const panel = fakePanel(450);
    // The first walk's third page: an operator creates an account by hand (ordered last).
    panel.beforePage = (_offset, page) => {
      if (page === 2) panel.names.push('zz-manual');
    };
    const needed = new Set([name(1), name(200), name(450)]);
    const read = complete(await sourceOf(panel).read(SCOPE, 'p1', { needed }));
    expect(read.resolution).toMatchObject({
      mode: 'TARGETED',
      reason: 'TOTAL_CHANGED',
      needed: 3,
      presentByWalks: 3,
      presentByLookup: 0,
      absentByLookup: 0,
      collisions: 0,
      unresolved: 0,
      lookups: 0,
    });
    expect(lookups(panel)).toEqual([]);
    expect([...read.index.usernames.keys()].sort()).toEqual([...needed].sort());
    expect(read.index.usernames.has('zz-manual')).toBe(false);
    expect(read.runtime.has('zz-manual')).toBe(false);
    for (const n of needed) expect(indexCovers(read.index, n)).toBe(true);
    // A name the backup did not ask about is not covered: never decided by this read.
    expect(indexCovers(read.index, 'zz-manual')).toBe(false);
    expect(indexCovers(read.index, name(2))).toBe(false);
  });

  it('a row the cursor slipped past (a deletion ahead of it) is looked up and found — present by lookup', async () => {
    const panel = fakePanel(300);
    // During the first walk's second page, an unrelated account on page one is deleted:
    // every later row shifts up by one and acc00101 is never served to the first walk.
    panel.beforePage = (_offset, page) => {
      if (page === 1) panel.names.splice(panel.names.indexOf(name(7)), 1);
    };
    const needed = new Set([name(101), name(250)]);
    const read = complete(await sourceOf(panel).read(SCOPE, 'p1', { needed }));
    expect(read.resolution).toMatchObject({
      reason: 'TOTAL_CHANGED',
      presentByWalks: 1,
      presentByLookup: 1,
      unresolved: 0,
      lookups: 1,
    });
    expect(lookups(panel)).toEqual([name(101)]);
    expect(read.index.usernames.get(name(101))).toEqual([name(101)]);
    expect(read.runtime.get(name(101))?.state).toBeDefined();
  });

  it('a needed account deleted during the read: the exact lookup answers 404 — proven absent, covered, not indexed', async () => {
    const panel = fakePanel(300);
    panel.beforePage = (_offset, page) => {
      if (page === 1) panel.names.splice(panel.names.indexOf(name(250)), 1);
    };
    const needed = new Set([name(10), name(250)]);
    const read = complete(await sourceOf(panel).read(SCOPE, 'p1', { needed }));
    expect(read.resolution).toMatchObject({ absentByLookup: 1, presentByWalks: 1, unresolved: 0 });
    expect(indexCovers(read.index, name(250))).toBe(true);
    expect(read.index.usernames.has(name(250))).toBe(false);
  });

  it('two spellings of one needed name: a collision, both spellings indexed, nothing adopted by guess', async () => {
    const panel = fakePanel(150);
    panel.names.push('ACC00005');
    panel.beforePage = (_offset, page) => {
      if (page === 1) panel.names.push('zz-new-sale');
    };
    const read = complete(await sourceOf(panel).read(SCOPE, 'p1', { needed: new Set([name(5)]) }));
    expect(read.resolution).toMatchObject({ collisions: 1, unresolved: 0, lookups: 0 });
    expect(read.index.usernames.get(name(5))).toEqual(['ACC00005', 'acc00005']);
  });

  it('a lookup that fails (5xx past the retry budget) leaves its name UNRESOLVED and no further name is asked', async () => {
    const panel = fakePanel(300);
    panel.beforePage = (_offset, page) => {
      if (page === 1) {
        panel.names.splice(0, 3); // three unrelated rows gone: three needed rows skipped
      }
    };
    panel.onLookup = () => answer(503, { detail: 'busy' });
    const needed = new Set([name(101), name(102), name(103), name(290)]);
    const read = complete(await sourceOf(panel).read(SCOPE, 'p1', { needed }));
    const r = read.resolution;
    expect(r?.lookups).toBe(1);
    expect(r?.unresolved).toBe(3);
    expect(r?.presentByWalks).toBe(1);
    // Five sends of one lookup (the first and the read's whole budget of 4), then none.
    expect(new Set(lookups(panel))).toEqual(new Set([name(101)]));
    for (const n of [name(101), name(102), name(103)]) {
      expect(indexCovers(read.index, n)).toBe(false);
    }
  });

  it('the lookup bound: a name past maxLookups is UNRESOLVED, never guessed', async () => {
    const panel = fakePanel(300);
    panel.beforePage = (_offset, page) => {
      if (page === 1) panel.names.splice(0, 2);
    };
    const needed = new Set([name(101), name(102)]);
    const read = complete(await sourceOf(panel, { maxLookups: 1 }).read(SCOPE, 'p1', { needed }));
    expect(read.resolution).toMatchObject({ lookups: 1, presentByLookup: 1, unresolved: 1 });
    expect(indexCovers(read.index, name(101))).toBe(true);
    expect(indexCovers(read.index, name(102))).toBe(false);
  });
});

describe('the targeted read changes nothing it does not need to', () => {
  it('a panel that holds still: the ordinary complete read — whole index, no resolution', async () => {
    const panel = fakePanel(250);
    const read = complete(await sourceOf(panel).read(SCOPE, 'p1', { needed: new Set([name(3)]) }));
    expect(read.resolution).toBeUndefined();
    expect(read.index.covered).toBeUndefined();
    expect(read.index.usernames.size).toBe(250);
    expect(lookups(panel)).toEqual([]);
  });

  it('nothing needed on this panel: not one request', async () => {
    const panel = fakePanel(250);
    const read = complete(await sourceOf(panel).read(SCOPE, 'p1', { needed: new Set() }));
    expect(read.resolution).toMatchObject({ reason: 'NOTHING_NEEDED', needed: 0 });
    expect(panel.log).toEqual([]);
  });

  it('a source not built targeted (CLI, rehearsal) ignores `needed`: TOTAL_CHANGED stays incomplete', async () => {
    const panel = fakePanel(300);
    panel.beforePage = (_offset, page) => {
      if (page === 1) panel.names.push('zz-manual');
    };
    const read = await sourceOf(panel, { targeted: false }).read(SCOPE, 'p1', {
      needed: new Set([name(1)]),
    });
    expect(read.ok && read.complete).toBe(false);
  });

  it('a refused login ends the read as before: no walk, no lookup', async () => {
    const panel = fakePanel(10);
    const client = clientOf(panel);
    const source = new RickpanelInventorySource(
      {
        panel: async () => ({ baseUrl: 'https://panel.invalid', providerType: 'rickpanel' }),
        credentials: async () => ({ username: 'admin', password: 'x', apiToken: null }),
        http: () => ({
          send: async (request) =>
            request.method === 'POST' ? answer(401, { detail: 'no' }) : client.send(request),
        }),
      },
      {
        pageSize: 100,
        clock: () => 0,
        sleep: async () => undefined,
        gate: new InProcessPanelReadGate(),
        targeted: true,
      },
      STAMP,
    );
    const read = await source.read(SCOPE, 'p1', { needed: new Set([name(1)]) });
    expect(read.ok).toBe(false);
    expect(lookups(panel)).toEqual([]);
  });
});

describe('classifyNeededNames / resolveLookup', () => {
  const acc = (u: string) => ({ username: u.toLowerCase(), providerUsername: u });

  it('present only when one spelling is seen by every walk', () => {
    const out = classifyNeededNames(new Set(['a', 'b', 'c']), [
      [acc('a'), acc('b')],
      [acc('a'), acc('C')],
    ]);
    expect(out.get('a')).toEqual({ kind: 'PRESENT', spelling: 'a' });
    expect(out.get('b')).toEqual({ kind: 'LOOKUP', ask: 'b', seen: 'b' });
    expect(out.get('c')).toEqual({ kind: 'LOOKUP', ask: 'C', seen: 'C' });
  });

  it('a collision seen across different walks still counts (the union of walks)', () => {
    const out = classifyNeededNames(new Set(['a']), [[acc('a')], [acc('A')]]);
    expect(out.get('a')).toEqual({ kind: 'COLLISION', spellings: ['A', 'a'] });
  });

  it('a needed name no walk saw is looked up by its canonical spelling; others are never classified', () => {
    const out = classifyNeededNames(new Set(['z']), [[acc('manual')], [acc('manual')]]);
    expect(out.get('z')).toEqual({ kind: 'LOOKUP', ask: 'z', seen: null });
    expect(out.has('manual')).toBe(false);
  });

  it('a lookup answering a different spelling than the walk saw is a collision, not a presence', () => {
    expect(
      resolveLookup({ kind: 'LOOKUP', ask: 'a', seen: 'a' }, { kind: 'FOUND', spelling: 'A' }),
    ).toEqual({ kind: 'COLLISION', spellings: ['A', 'a'] });
    expect(resolveLookup({ kind: 'LOOKUP', ask: 'a', seen: null }, { kind: 'NOT_FOUND' })).toEqual({
      kind: 'ABSENT',
    });
    expect(resolveLookup({ kind: 'LOOKUP', ask: 'a', seen: 'a' }, { kind: 'UNANSWERED' })).toEqual({
      kind: 'UNRESOLVED',
    });
  });

  it('refuses fewer than two walks', () => {
    expect(() => classifyNeededNames(new Set(['a']), [[acc('a')]])).toThrow();
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
    expect([...(out.get('panel-a') ?? [])]).toEqual(['alice']);
    expect([...(out.get('panel-b') ?? [])]).toEqual([]);
  });

  it('asks nothing for an unowned, test, invalid-key, nameless, unmapped or panel-less invoice', () => {
    const out = run([
      invoice({ idUser: 'stranger' }),
      invoice({ idUser: null }),
      invoice({ isTest: '1' }),
      invoice({ idInvoice: 'bogus' }),
      invoice({ username: '  ' }),
      invoice({ codePanel: 'code-unknown' }),
      invoice({ codePanel: 'code-test' }),
      invoice({ codePanel: null }),
    ]);
    expect([...(out.get('panel-a') ?? [])]).toEqual([]);
    expect([...(out.get('panel-b') ?? [])]).toEqual([]);
  });

  it('a declared-missing code asks every production panel; an operator ADOPT asks its panel', () => {
    const out = run(
      [
        invoice({ codePanel: 'code-gone' }),
        invoice({ idInvoice: 'inv-2', username: 'bob', codePanel: null }),
      ],
      new Map([['inv-2', 'panel-b']]),
    );
    expect([...(out.get('panel-a') ?? [])]).toEqual(['alice']);
    expect([...(out.get('panel-b') ?? [])].sort()).toEqual(['alice', 'bob']);
  });
});
