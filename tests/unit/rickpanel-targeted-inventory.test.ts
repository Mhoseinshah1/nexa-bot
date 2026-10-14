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
/** Needed names, each spelled in the backup exactly as on the panel. */
const need = (names: readonly string[]) => new Map(names.map((n) => [n, n] as const));

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

const lookups = (panel: FakePanel) =>
  panel.log.filter((r) => r.path.startsWith('api/user/')).map((r) => r.path.slice(9));

describe('a live panel that keeps selling during the dry run', () => {
  it('TOTAL_CHANGED from a manual account added mid-walk: every needed name decided, the manual account never asked or indexed', async () => {
    const panel = fakePanel(450);
    // The first walk's third page: an operator creates an account by hand (ordered last).
    panel.beforePage = (_offset, page) => {
      if (page === 2) panel.names.push('zz-manual');
    };
    const needed = need([name(1), name(200), name(450)]);
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
    expect([...read.index.usernames.keys()].sort()).toEqual([...needed.keys()].sort());
    expect(read.index.usernames.has('zz-manual')).toBe(false);
    expect(read.runtime.has('zz-manual')).toBe(false);
    for (const n of needed.keys()) expect(indexCovers(read.index, n)).toBe(true);
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
    const needed = need([name(101), name(250)]);
    const read = complete(await sourceOf(panel).read(SCOPE, 'p1', { needed }));
    expect(read.resolution).toMatchObject({
      reason: 'TOTAL_CHANGED',
      presentByWalks: 1,
      presentByLookup: 1,
      unresolved: 0,
      lookups: 2, // the canary, then the name
    });
    expect(lookups(panel)).toEqual([name(250), name(101)]);
    expect(read.index.usernames.get(name(101))).toEqual([name(101)]);
    expect(read.runtime.get(name(101))?.state).toBeDefined();
  });

  it('a needed account deleted during the read: the exact lookup answers 404 — proven absent, covered, not indexed', async () => {
    const panel = fakePanel(300);
    panel.beforePage = (_offset, page) => {
      if (page === 1) panel.names.splice(panel.names.indexOf(name(250)), 1);
    };
    const needed = need([name(10), name(250)]);
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
    const read = complete(await sourceOf(panel).read(SCOPE, 'p1', { needed: need([name(5)]) }));
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
    // The canary (acc00290, the first needed name both walks saw) answers; the others do not.
    panel.onLookup = (u) => (u === name(290) ? undefined : answer(503, { detail: 'busy' }));
    const needed = need([name(101), name(102), name(103), name(290)]); // acc00290: the canary
    const read = complete(await sourceOf(panel).read(SCOPE, 'p1', { needed }));
    const r = read.resolution;
    expect(r?.lookups).toBe(2);
    expect(r?.unresolved).toBe(3);
    expect(r?.presentByWalks).toBe(1);
    // Five sends of one lookup (the first and the read's whole budget of 4), then none.
    expect(new Set(lookups(panel))).toEqual(new Set([name(290), name(101)]));
    for (const n of [name(101), name(102), name(103)]) {
      expect(indexCovers(read.index, n)).toBe(false);
    }
  });

  it('the lookup bound: a name past maxLookups is UNRESOLVED, never guessed', async () => {
    const panel = fakePanel(300);
    panel.beforePage = (_offset, page) => {
      if (page === 1) panel.names.splice(0, 2);
    };
    const needed = need([name(101), name(102), name(250)]);
    const read = complete(await sourceOf(panel, { maxLookups: 2 }).read(SCOPE, 'p1', { needed }));
    expect(read.resolution).toMatchObject({ lookups: 2, presentByLookup: 1, unresolved: 1 });
    expect(indexCovers(read.index, name(101))).toBe(true);
    expect(indexCovers(read.index, name(102))).toBe(false);
  });
});

describe('the targeted read changes nothing it does not need to', () => {
  it('a panel that holds still: the ordinary complete read — whole index, no resolution', async () => {
    const panel = fakePanel(250);
    const read = complete(await sourceOf(panel).read(SCOPE, 'p1', { needed: need([name(3)]) }));
    expect(read.resolution).toBeUndefined();
    expect(read.index.covered).toBeUndefined();
    expect(read.index.usernames.size).toBe(250);
    expect(lookups(panel)).toEqual([]);
  });

  it('nothing needed on this panel: not one request', async () => {
    const panel = fakePanel(250);
    const read = complete(await sourceOf(panel).read(SCOPE, 'p1', { needed: new Map() }));
    expect(read.resolution).toMatchObject({ reason: 'NOTHING_NEEDED', needed: 0 });
    expect(panel.log).toEqual([]);
  });

  it('a source not built targeted (CLI, rehearsal) ignores `needed`: TOTAL_CHANGED stays incomplete', async () => {
    const panel = fakePanel(300);
    panel.beforePage = (_offset, page) => {
      if (page === 1) panel.names.push('zz-manual');
    };
    const read = await sourceOf(panel, { targeted: false }).read(SCOPE, 'p1', {
      needed: need([name(1)]),
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
    const read = await source.read(SCOPE, 'p1', { needed: need([name(1)]) });
    expect(read.ok).toBe(false);
    expect(lookups(panel)).toEqual([]);
  });
});

describe('classifyNeededNames / resolveLookup', () => {
  const acc = (u: string) => ({ username: u.toLowerCase(), providerUsername: u });

  it('present only when one spelling is seen by every walk', () => {
    const out = classifyNeededNames(need(['a', 'b', 'c']), [
      [acc('a'), acc('b')],
      [acc('a'), acc('C')],
    ]);
    expect(out.get('a')).toEqual({ kind: 'PRESENT', spelling: 'a' });
    expect(out.get('b')).toEqual({ kind: 'LOOKUP', ask: 'b', seen: 'b', backupSpelling: true });
    expect(out.get('c')).toEqual({ kind: 'LOOKUP', ask: 'C', seen: 'C', backupSpelling: false });
  });

  it('a collision seen across different walks still counts (the union of walks)', () => {
    const out = classifyNeededNames(need(['a']), [[acc('a')], [acc('A')]]);
    expect(out.get('a')).toEqual({ kind: 'COLLISION', spellings: ['A', 'a'] });
  });

  it('a needed name no walk saw is looked up by its canonical spelling; others are never classified', () => {
    const out = classifyNeededNames(need(['z']), [[acc('manual')], [acc('manual')]]);
    expect(out.get('z')).toEqual({ kind: 'LOOKUP', ask: 'z', seen: null, backupSpelling: true });
    expect(out.has('manual')).toBe(false);
  });

  it('a lookup answering a different spelling than the walk saw is a collision, not a presence', () => {
    expect(
      resolveLookup(
        { kind: 'LOOKUP', ask: 'a', seen: 'a', backupSpelling: true },
        { kind: 'FOUND', spelling: 'A' },
      ),
    ).toEqual({ kind: 'COLLISION', spellings: ['A', 'a'] });
    expect(
      resolveLookup(
        { kind: 'LOOKUP', ask: 'a', seen: null, backupSpelling: true },
        { kind: 'NOT_FOUND' },
      ),
    ).toEqual({
      kind: 'ABSENT',
    });
    expect(
      resolveLookup(
        { kind: 'LOOKUP', ask: 'a', seen: 'a', backupSpelling: true },
        { kind: 'UNANSWERED' },
      ),
    ).toEqual({
      kind: 'UNRESOLVED',
    });
  });

  it('refuses fewer than two walks', () => {
    expect(() => classifyNeededNames(need(['a']), [[acc('a')]])).toThrow();
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
    expect([...(out.get('panel-a') ?? new Map()).keys()]).toEqual([]);
    expect([...(out.get('panel-b') ?? new Map()).keys()]).toEqual([]);
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

describe('Codex review on #283', () => {
  it("a 404 for a name no walk saw decides it only when the backup's own spelling was asked", () => {
    const guessed = { kind: 'LOOKUP', ask: 'alice', seen: null, backupSpelling: false } as const;
    const exact = { kind: 'LOOKUP', ask: 'Alice', seen: null, backupSpelling: true } as const;
    expect(resolveLookup(guessed, { kind: 'NOT_FOUND' })).toEqual({ kind: 'UNRESOLVED' });
    expect(resolveLookup(exact, { kind: 'NOT_FOUND' })).toEqual({ kind: 'ABSENT' });
    // The backup spells it two ways: the canonical name is a guess.
    const out = classifyNeededNames(new Map([['alice', null]]), [[], []]);
    expect(out.get('alice')).toEqual({
      kind: 'LOOKUP',
      ask: 'alice',
      seen: null,
      backupSpelling: false,
    });
    // The backup's mixed-case spelling is what is asked, not the lowercase key.
    const mixed = classifyNeededNames(new Map([['alice', 'Alice']]), [[], []]);
    expect(mixed.get('alice')).toEqual({
      kind: 'LOOKUP',
      ask: 'Alice',
      seen: null,
      backupSpelling: true,
    });
  });

  it('end to end: an unseen name the backup spells two ways and the panel 404s stays UNRESOLVED', async () => {
    const panel = fakePanel(300);
    panel.beforePage = (_offset, page) => {
      if (page === 1) panel.names.push('zz-manual');
    };
    const needed = new Map<string, string | null>([
      [name(10), name(10)],
      ['ghost', null],
      ['gone', 'gone'],
    ]);
    const read = complete(await sourceOf(panel).read(SCOPE, 'p1', { needed }));
    expect(read.resolution).toMatchObject({ presentByWalks: 1, absentByLookup: 1, unresolved: 1 });
    expect(indexCovers(read.index, 'ghost')).toBe(false);
    expect(indexCovers(read.index, 'gone')).toBe(true);
  });

  it('a runtime fact is stamped when the walks ended, not after the lookups', async () => {
    const panel = fakePanel(300);
    panel.beforePage = (_offset, page) => {
      if (page === 1) panel.names.splice(0, 1);
    };
    let stamps = 0;
    const stamp = () => new Date(Date.UTC(2026, 9, 14, 8, 0, stamps++));
    const read = complete(
      await sourceOf(panel, {}, stamp).read(SCOPE, 'p1', { needed: need([name(101), name(250)]) }),
    );
    expect(read.resolution?.lookups).toBe(2);
    // The first (and only) stamp of the read, taken before the lookup was sent.
    expect(read.observedAt.toISOString()).toBe('2026-10-14T08:00:00.000Z');
  });

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
                lookups: 0,
                unresolved: 0,
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
          presentByWalks: 5 - unresolved,
          presentByLookup: 0,
          absentByLookup: 0,
          collisions: 0,
          unresolved,
          lookups: unresolved,
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

describe('independent audit on #283', () => {
  it('a route that answers 404 to everything (a proxy, a missing route): the canary fails, no name is called absent', async () => {
    const panel = fakePanel(300);
    panel.beforePage = (_offset, page) => {
      if (page === 1) panel.names.splice(0, 2);
    };
    panel.onLookup = () => answer(404, { detail: 'Not Found' });
    const read = complete(
      await sourceOf(panel).read(SCOPE, 'p1', { needed: need([name(101), name(102), name(250)]) }),
    );
    expect(read.resolution).toMatchObject({ absentByLookup: 0, unresolved: 2, lookups: 1 });
    expect(lookups(panel)).toEqual([name(250)]); // the canary only
  });

  it('a list that withholds a row under a total that never moved (COUNT_MISMATCH) stays incomplete', async () => {
    const panel = fakePanel(150);
    panel.names.push('ACC00005'); // counted by the total, never served by the list
    const client = clientOf(panel);
    const hiding: ProviderHttpClient = {
      send: async (request) => {
        const result = await client.send(request);
        if (!result.ok || !request.path.startsWith('api/users')) return result;
        const body = JSON.parse(result.bodyText) as {
          users: { username: string }[];
          total: number;
        };
        body.users = body.users.filter((u) => u.username !== 'ACC00005');
        return { ...result, bodyText: JSON.stringify(body) };
      },
    };
    const source = new RickpanelInventorySource(
      {
        panel: async () => ({ baseUrl: 'https://panel.invalid', providerType: 'rickpanel' }),
        credentials: async () => ({ username: 'admin', password: 'synthetic', apiToken: null }),
        http: () => hiding,
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
    const read = await source.read(SCOPE, 'p1', { needed: need([name(5)]) });
    expect(read).toMatchObject({ ok: true, complete: false, reason: 'COUNT_MISMATCH' });
  });

  it('two consistent walks that differ (WALKS_DIFFER): a name only the first saw is looked up, not called missing', async () => {
    const panel = fakePanel(250);
    let pages = 0;
    panel.beforePage = () => {
      pages += 1;
      // After the first walk's three pages: one account replaced by another (total unchanged).
      if (pages === 4) {
        panel.names.splice(panel.names.indexOf(name(200)), 1);
        panel.names.push('zz-new');
      }
    };
    const read = complete(
      await sourceOf(panel).read(SCOPE, 'p1', { needed: need([name(200), name(10)]) }),
    );
    expect(read.resolution).toMatchObject({
      reason: 'WALKS_DIFFER',
      presentByWalks: 1,
      absentByLookup: 1,
      unresolved: 0,
    });
  });

  it('a lookup is retried like a page: a 503 then the record — present, one retry spent', async () => {
    const panel = fakePanel(300);
    panel.beforePage = (_offset, page) => {
      if (page === 1) panel.names.splice(0, 1);
    };
    let failed = false;
    panel.onLookup = (u) => {
      if (u === name(101) && !failed) {
        failed = true;
        return answer(503, { detail: 'busy' });
      }
      return undefined;
    };
    const read = complete(
      await sourceOf(panel).read(SCOPE, 'p1', { needed: need([name(101), name(250)]) }),
    );
    expect(read.resolution).toMatchObject({ presentByLookup: 1, unresolved: 0 });
    expect(read.diagnostics?.load?.retries).toBe(1);
  });

  it('a dot segment is never put in a lookup path', async () => {
    const panel = fakePanel(300);
    panel.beforePage = (_offset, page) => {
      if (page === 1) panel.names.splice(0, 1);
    };
    const read = complete(await sourceOf(panel).read(SCOPE, 'p1', { needed: need(['..']) }));
    expect(read.resolution).toMatchObject({ unresolved: 1 });
    expect(lookups(panel).some((l) => l.includes('..'))).toBe(false);
  });
});

describe('the canary is a name the backup needs', () => {
  it('never asks for an account the backup does not name; with no needed name both walks saw, no lookup is sent', async () => {
    const panel = fakePanel(300);
    panel.beforePage = (_offset, page) => {
      if (page === 1) panel.names.splice(0, 2);
    };
    // acc00101 and acc00102 slipped past the first walk; nothing the backup needs was seen by both.
    const read = complete(
      await sourceOf(panel).read(SCOPE, 'p1', { needed: need([name(101), name(102)]) }),
    );
    expect(lookups(panel)).toEqual([]);
    expect(read.resolution).toMatchObject({ lookups: 0, unresolved: 2 });
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

describe('Codex review on a2c54ea7', () => {
  it('a name the backup spells two ways that no walk saw is never asked, and a hit would not decide it', async () => {
    expect(
      resolveLookup(
        { kind: 'LOOKUP', ask: 'alice', seen: null, backupSpelling: false },
        { kind: 'FOUND', spelling: 'alice' },
      ),
    ).toEqual({ kind: 'UNRESOLVED' });
    const panel = fakePanel(300);
    panel.beforePage = (_offset, page) => {
      if (page === 1) panel.names.splice(0, 1);
    };
    // 'zz-hidden' is not on the panel's list at all; the backup spells it two ways (null).
    const needed = new Map<string, string | null>([
      [name(250), name(250)],
      ['zz-hidden', null],
    ]);
    const read = complete(await sourceOf(panel).read(SCOPE, 'p1', { needed }));
    expect(lookups(panel)).not.toContain('zz-hidden');
    expect(indexCovers(read.index, 'zz-hidden')).toBe(false);
    expect(read.resolution).toMatchObject({ unresolved: 1 });
  });

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
            presentByWalks: 0,
            presentByLookup: 0,
            absentByLookup: 0,
            collisions: 0,
            unresolved: 0,
            lookups: 0,
          },
        },
      ],
    ]);
    expect(observedAtFor('p1', notRead)).toBeNull();
  });
});
