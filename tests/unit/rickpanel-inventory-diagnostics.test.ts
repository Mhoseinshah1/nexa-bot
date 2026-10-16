import { describe, expect, it } from 'vitest';
import {
  legacyMigrationDryRunReportSchema,
  type LegacyInventoryWalkDiagnostics,
} from '@nexa/contracts';
import {
  RickpanelInventoryReader,
  createdAtFormat,
  readOnlyRickpanelHttp,
  type RickpanelInventoryWalk,
  type RickpanelWalkDiagnostics,
} from '../../apps/api/src/modules/platform/providers/infrastructure/rickpanel-inventory';
import {
  decideNeededNames,
  decideNeededNamesWithCauses,
} from '../../apps/api/src/modules/platform/legacy-importer/application/inventory-resolution';
import type { LegacyInventoryRead } from '../../apps/api/src/modules/platform/legacy-importer/application/ports';
import { providerDiagnostics } from '../../apps/api/src/modules/platform/legacy-migration/infrastructure/nxpkg-migration-adapters';
import {
  FAKE_BASE_URL,
  FAKE_PASSWORD,
  FAKE_TOKEN,
  appendAccount,
  fakeListClient,
  fakeListPanel,
  fakeListSource,
  fakeName as name,
  insertAccountAt,
  type FakeListPanel,
} from '../support/fake-rickpanel-list';

/**
 * Per-name RickPanel read DIAGNOSTICS (`docs/rickpanel-inventory.md` §Diagnostics): why a walk
 * is or is not gap-free, and why a needed name stayed unresolved — numbers and closed codes,
 * never a name. Diagnostics only: the decisions are pinned unchanged by the existing suites
 * (`rickpanel-targeted-inventory*.test.ts`, `nxpkg-*.test.ts`), which this change leaves
 * untouched; here, `decideNeededNames` is checked to BE `decideNeededNamesWithCauses` minus the
 * causes. SYNTHETIC fake panel only.
 */

const target = {
  baseUrl: FAKE_BASE_URL,
  credentials: { shape: 'USERNAME_PASSWORD', username: 'admin', password: FAKE_PASSWORD },
} as const;

async function walkOf(panel: FakeListPanel, pageSize = 100, overlap = 10) {
  let t = 0;
  const walk = await new RickpanelInventoryReader().walk(
    target as never,
    readOnlyRickpanelHttp(fakeListClient(panel)),
    { pageSize, overlap, clock: () => (t += 7) },
  );
  if (!walk.ok) throw new Error(`walk failed: ${JSON.stringify(walk)}`);
  const coverage = walk.coverage;
  if (coverage === undefined) throw new Error('no coverage');
  return { walk, coverage, d: coverage.diagnostics };
}

/** gapFree is computed as before; its failures are exactly the conditions that failed. */
function consistent(gapFree: boolean, d: RickpanelWalkDiagnostics) {
  expect(gapFree).toBe(d.failures.length === 0);
  expect(d.firstFailure === null).toBe(gapFree);
  if (d.firstFailure !== null) expect(d.failures).toContain(d.firstFailure.kind);
}

const breaks = (d: RickpanelWalkDiagnostics) =>
  Object.fromEntries(Object.entries(d.chainBreaks).filter(([, n]) => n > 0));

// 300 accounts at 100 a page, overlap 10: pages start at 0, 90, 180, 270.

describe('a walk says why it is or is not gap-free', () => {
  it('a still panel: gap-free, no failure, ended exactly at its total, every count reported', async () => {
    const { coverage, d } = await walkOf(fakeListPanel(300));
    consistent(coverage.gapFree, d);
    expect(coverage.gapFree).toBe(true);
    expect(d).toMatchObject({
      failures: [],
      firstFailure: null,
      overlapApplied: 10,
      learnedLimit: null,
      reportedTotalFirst: 300,
      reportedTotalLast: 300,
      reportedTotalMaxChange: 0,
      endedOffsetMinusTotal: 0,
      createdAt: { rowsWithout: 0, rowsUnparsable: 0, inversions: 0, maxInversionMs: 0 },
    });
    // `toISOString` stamps: an offset (Z) and milliseconds.
    expect(d.createdAt.formats).toMatchObject({ OFFSET: 300, FRACTIONAL: 300, NAIVE: 0 });
    expect(breaks(d)).toEqual({});
    expect(d.durationMs).toBeGreaterThan(0);
  });

  it('no total: NO_TOTAL and NOT_ENDED_AT_TOTAL, from the first page', async () => {
    const panel = fakeListPanel(300);
    panel.noTotal = true;
    const { coverage, d } = await walkOf(panel);
    consistent(coverage.gapFree, d);
    expect(d.failures).toEqual(['NO_TOTAL', 'NOT_ENDED_AT_TOTAL']);
    expect(d.firstFailure).toEqual({ kind: 'NO_TOTAL', pageIndex: 0 });
    expect(d.reportedTotalFirst).toBeNull();
    expect(d.endedOffsetMinusTotal).toBeNull();
  });

  it('one row without created_at: CREATED_ORDER on the page that first returned it', async () => {
    const panel = fakeListPanel(300);
    panel.createdAtOf = (u, s) =>
      u === name(150) ? undefined : new Date(Date.UTC(2026, 0, 1) + s * 1000).toISOString();
    const { coverage, d } = await walkOf(panel);
    consistent(coverage.gapFree, d);
    expect(d.failures).toEqual(['CREATED_ORDER']);
    // Row 150 (index 149) is first received on the page at offset 90.
    expect(d.firstFailure).toEqual({ kind: 'CREATED_ORDER', pageIndex: 1 });
    expect(d.createdAt).toMatchObject({ rowsWithout: 1, rowsUnparsable: 0, inversions: 0 });
  });

  it('one row stamped before its predecessor: an inversion, and by how much', async () => {
    const panel = fakeListPanel(300);
    panel.created.set(name(200), 50);
    const { coverage, d } = await walkOf(panel);
    consistent(coverage.gapFree, d);
    expect(d.failures).toEqual(['CREATED_ORDER']);
    expect(d.firstFailure).toEqual({ kind: 'CREATED_ORDER', pageIndex: 2 });
    // 199 s (the row before) back to 50 s.
    expect(d.createdAt).toMatchObject({ inversions: 1, maxInversionMs: 149_000, rowsWithout: 0 });
  });

  it('epoch numbers: EPOCH_LIKE and unparsable, never a usable order', async () => {
    const panel = fakeListPanel(300);
    panel.createdAtOf = (_u, s) => 1_767_225_600 + s;
    const { coverage, d } = await walkOf(panel);
    consistent(coverage.gapFree, d);
    expect(d.failures).toEqual(['CREATED_ORDER']);
    expect(d.firstFailure).toEqual({ kind: 'CREATED_ORDER', pageIndex: 0 });
    expect(d.createdAt.formats.EPOCH_LIKE).toBe(300);
    expect(d.createdAt.rowsUnparsable).toBe(300);
    expect(d.createdAt.inversions).toBe(0);
  });

  it('naive stamps are classified NAIVE (they parse as local time) and still order', async () => {
    const panel = fakeListPanel(300);
    panel.createdAtOf = (_u, s) =>
      new Date(Date.UTC(2026, 0, 1) + s * 1000).toISOString().slice(0, 19);
    const { coverage, d } = await walkOf(panel);
    consistent(coverage.gapFree, d);
    expect(coverage.gapFree).toBe(true);
    expect(d.createdAt.formats).toMatchObject({ NAIVE: 300, OFFSET: 0, FRACTIONAL: 0 });
  });

  it('a page cap: learned from the first page, the overlap kept within a quarter of it', async () => {
    const panel = fakeListPanel(300);
    panel.cap = 20;
    const { coverage, d } = await walkOf(panel);
    consistent(coverage.gapFree, d);
    expect(d.learnedLimit).toBe(20);
    expect(d.overlapApplied).toBe(5);
  });

  it('a page longer than the learned cap: PAGE_LONGER_THAN_CAP', async () => {
    const panel = fakeListPanel(300);
    panel.cap = (page) => (page === 0 ? 50 : 100);
    const { coverage, d } = await walkOf(panel);
    consistent(coverage.gapFree, d);
    expect(d.learnedLimit).toBe(50);
    // Every later page is longer than the cap the first page taught.
    expect(d.chainBreaks.PAGE_LONGER_THAN_CAP).toBe(3);
    expect(d.firstFailure).toEqual({ kind: 'UNCHAINED', pageIndex: 1 });
  });

  it('a burst of deletions behind the cursor: NO_COMMON_ROW on that boundary', async () => {
    const panel = fakeListPanel(300);
    panel.beforePage = (_o, page) => {
      if (page === 1) panel.names.splice(0, 15);
    };
    const { coverage, d } = await walkOf(panel);
    consistent(coverage.gapFree, d);
    expect(d.failures).toContain('UNCHAINED');
    expect(breaks(d)).toEqual({ NO_COMMON_ROW: 1 });
    expect(d.firstFailure).toEqual({ kind: 'UNCHAINED', pageIndex: 1 });
  });

  it('an account inserted behind the cursor (mid-list): INSERT_AHEAD_MISSED', async () => {
    const panel = fakeListPanel(300);
    panel.beforePage = (_o, page) => {
      if (page === 1) insertAccountAt(panel, 20, 'zz-mid-list');
    };
    const { coverage, d } = await walkOf(panel);
    consistent(coverage.gapFree, d);
    expect(breaks(d)).toEqual({ INSERT_AHEAD_MISSED: 1 });
  });

  it('an order that differs by request: COMMON_ORDER_DIFFERS (and the created order breaks)', async () => {
    const panel = fakeListPanel(300);
    panel.view = (rows, _o, _l, page) => (page % 2 === 1 ? [...rows].reverse() : rows);
    const { coverage, d } = await walkOf(panel);
    consistent(coverage.gapFree, d);
    expect(d.chainBreaks.COMMON_ORDER_DIFFERS).toBeGreaterThan(0);
    expect(d.failures).toEqual(expect.arrayContaining(['CREATED_ORDER', 'UNCHAINED']));
  });

  it('a row repeated outside the overlap, and one twice in a page', async () => {
    const repeated = fakeListPanel(300);
    repeated.view = (rows, offset) => (offset === 180 ? [...rows.slice(0, -1), name(5)] : rows);
    const a = await walkOf(repeated);
    consistent(a.coverage.gapFree, a.d);
    expect(a.d.chainBreaks.REPEAT_OUTSIDE_OVERLAP).toBe(1);

    const twice = fakeListPanel(300);
    twice.view = (rows, offset) =>
      offset === 180 ? [...rows.slice(0, -1), rows[0] as string] : rows;
    const b = await walkOf(twice);
    consistent(b.coverage.gapFree, b.d);
    expect(b.d.chainBreaks.DUPLICATE_IN_PAGE).toBe(1);
  });

  it('a sale mid-walk: the total moved, by how much, and the walk still ended at its own total', async () => {
    const panel = fakeListPanel(300);
    panel.beforePage = (_o, page) => {
      if (page === 2) appendAccount(panel, 'zz-sale');
    };
    const { coverage, d } = await walkOf(panel);
    consistent(coverage.gapFree, d);
    expect(coverage.gapFree).toBe(true);
    expect(d).toMatchObject({
      reportedTotalFirst: 300,
      reportedTotalLast: 301,
      reportedTotalMaxChange: 1,
      endedOffsetMinusTotal: 0,
    });
  });

  it('no overlap (a page too small to overlap): NO_OVERLAP', async () => {
    const { coverage, d } = await walkOf(fakeListPanel(10), 1, 1);
    consistent(coverage.gapFree, d);
    expect(d.failures[0]).toBe('NO_OVERLAP');
    expect(d.overlapApplied).toBe(0);
  });

  it('a non-overlapping walk carries no diagnostics, as before', async () => {
    const walk: RickpanelInventoryWalk = await new RickpanelInventoryReader().walk(
      target as never,
      readOnlyRickpanelHttp(fakeListClient(fakeListPanel(30))),
      { pageSize: 10 },
    );
    expect(walk.ok && walk.coverage).toBeFalsy();
  });
});

describe('createdAtFormat', () => {
  it.each([
    ['2026-01-01T00:00:05', 'NAIVE', false],
    ['2026-01-01 00:00:05.123456', 'NAIVE', true],
    ['2026-01-01T00:00:05Z', 'OFFSET', false],
    ['2026-01-01T00:00:05.5+03:30', 'OFFSET', true],
    ['1767225600', 'EPOCH_LIKE', false],
    [1_767_225_600, 'EPOCH_LIKE', false],
    ['yesterday', 'OTHER', false],
    [{}, 'OTHER', false],
  ])('%s → %s', (value, base, fractional) => {
    expect(createdAtFormat(value)).toEqual({ base, fractional });
  });
});

describe('every unresolved name has exactly one cause; decisions unchanged', () => {
  const acc = (u: string) => ({ username: u.toLowerCase(), providerUsername: u });
  const walk = (names: string[], created: Record<string, string[]> = {}, decisive = true) => ({
    accounts: names.map(acc),
    createdAt: new Map(names.map((n) => [n, new Set(created[n] ?? ['t0'])])),
    decisive,
  });
  const need = (pairs: [string, string | null][]) => new Map(pairs);

  it('names each cause', () => {
    const needed = need([
      ['a', 'a'],
      ['d', null],
      ['f', 'f'],
      ['u', 'u'],
      ['r', 'r'],
    ]);
    const walks = [
      walk(['a', 'f', 'u']),
      walk(['a', 'f', 'r'], { f: ['t1'] }, false),
      walk(['a', 'f', 'r'], { f: ['t1'] }, false),
    ];
    const { resolved, causes } = decideNeededNamesWithCauses(needed, walks, 0);
    expect(resolved).toEqual(decideNeededNames(needed, walks, 0));
    expect(resolved.get('a')).toEqual({ kind: 'PRESENT', spelling: 'a' });
    expect(Object.fromEntries(causes)).toEqual({
      d: 'BACKUP_TWO_SPELLINGS',
      f: 'MULTI_CREATED_AT',
      u: 'UNCONFIRMED',
      r: 'REAPPEARED',
    });
    const blind = decideNeededNamesWithCauses(needed, walks, null);
    expect(Object.fromEntries(blind.causes)).toEqual({
      a: 'NO_DECISION_WALK',
      d: 'BACKUP_TWO_SPELLINGS',
      f: 'NO_DECISION_WALK',
      u: 'NO_DECISION_WALK',
      r: 'NO_DECISION_WALK',
    });
    for (const out of [{ resolved, causes }, blind]) {
      const unresolved = [...out.resolved].filter(([, r]) => r.kind === 'UNRESOLVED');
      expect(unresolved.map(([n]) => n).sort()).toEqual([...out.causes.keys()].sort());
    }
  });

  it('a row with no creation time is MULTI_CREATED_AT, never present', () => {
    const { resolved, causes } = decideNeededNamesWithCauses(
      need([['k', 'k']]),
      [{ accounts: [acc('k')], createdAt: new Map(), decisive: true }, walk(['k'])],
      0,
    );
    expect(resolved.get('k')).toEqual({ kind: 'UNRESOLVED' });
    expect(causes.get('k')).toBe('MULTI_CREATED_AT');
  });
});

type Complete = Extract<LegacyInventoryRead, { ok: true; complete: true }>;
function complete(read: LegacyInventoryRead): Complete {
  if (!read.ok || !read.complete)
    throw new Error(`expected a complete read: ${JSON.stringify(read)}`);
  return read;
}
const needOf = (names: readonly string[]) => new Map(names.map((n) => [n, n] as const));
const SCOPE = { tenantId: '11111111-1111-4111-8111-111111111111' } as never;
const PANEL_ID = '019600ab-cdef-7012-8345-6789abcd0401';
const causeSum = (read: Complete) =>
  (read.diagnostics?.perName?.unresolvedByCause ?? []).reduce((a, c) => a + c.count, 0);

describe('a per-name read reports its walks and its causes', () => {
  it('a still panel: one snapshot, two gap-free decisive walks, no cause', async () => {
    const read = complete(
      await fakeListSource(fakeListPanel(300)).source.read(SCOPE, PANEL_ID, {
        needed: needOf([name(1), name(200)]),
      }),
    );
    expect(read.resolution).toBeUndefined();
    const perName = read.diagnostics?.perName;
    expect(perName?.decisionWalk).toBeNull();
    expect(perName?.unresolvedByCause).toEqual([]);
    expect(perName?.walks.map((w) => [w.gapFree, w.decisive, w.sameOrderAsPrevious])).toEqual([
      [true, true, null],
      [true, true, true],
    ]);
  });

  it('rows without created_at on a selling panel: every name NO_DECISION_WALK, and the walks say CREATED_ORDER', async () => {
    const panel = fakeListPanel(300);
    panel.createdAtOf = () => undefined;
    panel.beforePage = (_o, page) => {
      if (page === 1 || page === 5 || page === 9) appendAccount(panel, `zz-sale-${String(page)}`);
    };
    const needed = needOf([name(1), name(150), name(299)]);
    const read = complete(await fakeListSource(panel).source.read(SCOPE, PANEL_ID, { needed }));
    expect(read.resolution).toMatchObject({ unresolved: 3, gapFree: false });
    const perName = read.diagnostics?.perName;
    expect(perName?.decisionWalk).toBeNull();
    expect(perName?.unresolvedByCause).toEqual([{ code: 'NO_DECISION_WALK', count: 3 }]);
    expect(causeSum(read)).toBe(read.resolution?.unresolved);
    for (const w of perName?.walks ?? []) {
      expect(w.failures).toContain('CREATED_ORDER');
      expect(w.createdAt.rowsWithout).toBeGreaterThan(0);
      expect(w.firstFailure).toEqual({ kind: 'CREATED_ORDER', pageIndex: 0 });
    }
  });

  it('a decision walk, but bursts in the later walks: the would-be decisions are LAST_NOT_DECISIVE', async () => {
    const panel = fakeListPanel(300);
    panel.beforePage = (_o, page) => {
      if (page === 5 || page === 9) panel.names.splice(0, 15);
    };
    const needed = needOf([name(200), name(250)]);
    const read = complete(await fakeListSource(panel).source.read(SCOPE, PANEL_ID, { needed }));
    expect(read.resolution).toMatchObject({ walks: 3, unresolved: 2 });
    const perName = read.diagnostics?.perName;
    expect(perName?.decisionWalk).toBe(0);
    expect(perName?.unresolvedByCause).toEqual([{ code: 'LAST_NOT_DECISIVE', count: 2 }]);
    expect(perName?.walks.map((w) => w.gapFree)).toEqual([true, false, false]);
    expect(perName?.walks[1]?.chainBreaks).toEqual([{ code: 'NO_COMMON_ROW', count: 1 }]);
    expect(causeSum(read)).toBe(read.resolution?.unresolved);
  });

  it('carries no name, no token, no password and no address', async () => {
    const panel = fakeListPanel(300);
    panel.createdAtOf = () => undefined;
    const read = await fakeListSource(panel).source.read(SCOPE, PANEL_ID, {
      needed: needOf([name(7)]),
    });
    const text = JSON.stringify(read.diagnostics);
    for (const secret of ['acc0', FAKE_TOKEN, FAKE_PASSWORD, 'panel-g6.invalid']) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('the dry-run report projects the diagnostics, validated, per panel', () => {
  const reportWith = (panels: unknown[]) =>
    ({ sections: { provider: { panels } } }) as unknown as Parameters<
      typeof providerDiagnostics
    >[0];

  async function unresolvedPanel() {
    const panel = fakeListPanel(300);
    panel.createdAtOf = () => undefined;
    panel.beforePage = (_o, page) => {
      if (page === 1 || page === 5 || page === 9) appendAccount(panel, `zz-${String(page)}`);
    };
    const read = complete(
      await fakeListSource(panel).source.read(SCOPE, PANEL_ID, { needed: needOf([name(9)]) }),
    );
    return {
      panelId: PANEL_ID,
      complete: false,
      reason: 'UNRESOLVED',
      resolution: read.resolution,
      diagnostics: read.diagnostics,
    };
  }

  it('one entry per per-name panel, closed codes and counts only, in the contract shape', async () => {
    const out = providerDiagnostics(
      reportWith([
        await unresolvedPanel(),
        // Never read: no diagnostics.
        { panelId: PANEL_ID, resolution: { reason: 'NOTHING_NEEDED' }, diagnostics: {} },
        // A complete snapshot read with no per-name resolution: none either.
        { panelId: PANEL_ID, complete: true, resolution: null, diagnostics: { walks: [] } },
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      panelId: PANEL_ID,
      reason: 'TOTAL_CHANGED',
      needed: 1,
      unresolved: 1,
      decisionWalk: null,
      unresolvedByCause: [{ code: 'NO_DECISION_WALK', count: 1 }],
    });
    expect(
      (out[0]?.walks ?? []).every((w: LegacyInventoryWalkDiagnostics) =>
        w.failures.includes('CREATED_ORDER'),
      ),
    ).toBe(true);
    expect(JSON.stringify(out)).not.toContain('acc0');
  });

  it('anything outside the closed shape is left out, never echoed', async () => {
    const good = await unresolvedPanel();
    const smuggled = structuredClone(good) as unknown as {
      diagnostics: { perName: { walks: unknown[] } };
    };
    (smuggled.diagnostics.perName.walks[0] as { failures: string[] }).failures = ['acc00009'];
    const badCause = structuredClone(good) as unknown as {
      diagnostics: { perName: Record<string, unknown> };
    };
    badCause.diagnostics.perName['unresolvedByCause'] = [{ code: 'acc00009', count: 1 }];
    const badId = { ...good, panelId: 'https://panel.example/x' };
    expect(providerDiagnostics(reportWith([smuggled, badCause, badId]))).toEqual([]);
  });

  it('an old report without the field still parses; a new one keeps it; a foreign code does not parse', async () => {
    const base = {
      importerVerdict: 'DRY_RUN',
      sections: [],
      warnings: [],
      quarantine: [],
      wallets: { currency: 'IRT', customers: 0, beforeTotalMinor: '0', afterTotalMinor: '0' },
      debts: { currency: 'IRT', count: 0, totalMinor: '0' },
      ownership: {
        decisionsProvided: false,
        proven: 0,
        adminApprovedUnverified: 0,
        quarantined: 0,
        rejected: 0,
        pending: 0,
        stale: 0,
      },
      cutover: Object.fromEntries(
        [
          'sourceFingerprint',
          'panelMapFingerprint',
          'inventoryFingerprint',
          'productsFingerprint',
          'invoiceArchiveFingerprint',
          'freezeProofSha256',
          'finalDumpSha256',
        ].map((k) => [k, 'a'.repeat(64)]),
      ),
      planTalliesDigest: null,
    };
    const old = legacyMigrationDryRunReportSchema.safeParse(base);
    expect(old.success).toBe(true);
    expect(old.success && 'providerDiagnostics' in old.data).toBe(false);
    const diagnostics = providerDiagnostics(reportWith([await unresolvedPanel()]));
    const fresh = legacyMigrationDryRunReportSchema.safeParse({
      ...base,
      providerDiagnostics: diagnostics,
    });
    expect(fresh.success && fresh.data.providerDiagnostics).toEqual(diagnostics);
    const foreign = legacyMigrationDryRunReportSchema.safeParse({
      ...base,
      providerDiagnostics: [{ ...diagnostics[0], unresolvedByCause: [{ code: 'X', count: 1 }] }],
    });
    expect(foreign.success).toBe(false);
  });
});

// A real RickPanel (2026-10-16) lists `api/users` in an order that is neither creation order nor
// its reverse unless asked `sort=created_at`: every per-name walk failed CREATED_ORDER and the
// adopt lane decided none of 200 approved names. The read now asks for creation order; the
// proof still checks the order on the rows, so a panel that ignores the parameter fails closed.
describe('the list is asked oldest first (sort=created_at)', () => {
  /** Neither ascending nor descending: odd positions first, then even ones reversed. */
  const scrambled = (names: readonly string[]) => [
    ...names.filter((_n, i) => i % 2 === 1),
    ...names.filter((_n, i) => i % 2 === 0).reverse(),
  ];

  /**
   * A selling panel. 300 accounts at 100 a page, overlap 10: four pages a walk (pages 0-3, 4-7,
   * 8-11). Created during the reads: `zz-sale-early` (walk 1), `zz-sale-late` (walk 2), and one
   * per later page. Deleted during the reads: three accounts behind the cursor in walk 1 (a
   * burst the overlap absorbs), and `acc00150` — read by walk 1 — before walk 2 starts.
   */
  function sellingPanel() {
    const panel = fakeListPanel(300);
    panel.unsortedOrder = scrambled;
    panel.beforePage = (_offset, page) => {
      if (page === 1) appendAccount(panel, 'zz-sale-early');
      if (page === 2) panel.names.splice(5, 3); // acc00006..acc00008, behind the cursor
      if (page === 4) panel.names.splice(panel.names.indexOf(name(150)), 1);
      if (page === 6) appendAccount(panel, 'zz-sale-late');
      if (page === 9) appendAccount(panel, `zz-sale-${String(page)}`);
    };
    return panel;
  }
  const needed = [name(10), name(150), name(7), 'zz-sale-early', 'zz-sale-late', 'zz-ghost'];

  it('a selling panel, read oldest first: every needed name decided — none skipped, none counted twice, a deleted one never present', async () => {
    const panel = sellingPanel();
    const read = complete(
      await fakeListSource(panel).source.read(SCOPE, PANEL_ID, { needed: needOf(needed) }),
    );
    expect(read.resolution).toMatchObject({ needed: 6, unresolved: 0, collisions: 0 });
    const decided = (n: string) => indexCoversName(read, n);
    const present = (n: string) => (read.index.usernames.get(n) ?? []).length === 1;
    for (const n of needed) expect(decided(n)).toBe(true);
    // Present through every walk, and created during the read and seen by a later walk.
    expect(present(name(10))).toBe(true);
    expect(present('zz-sale-early')).toBe(true);
    // Deleted mid-read (after walk 1 saw it), deleted behind the cursor, never created.
    expect(present(name(150))).toBe(false);
    expect(present(name(7))).toBe(false);
    expect(present('zz-ghost')).toBe(false);
    expect(read.resolution?.present).toBe(needed.filter((n) => present(n)).length);
    // Every list request asked for creation order; nothing but the token exchange and GETs.
    const lists = panel.log.filter((r) => r.method === 'GET');
    expect(lists.length).toBeGreaterThan(0);
    for (const r of lists)
      expect(r.path).toMatch(/^api\/users\?offset=\d+&limit=\d+&sort=created_at$/u);
    expect(panel.log.every((r) => r.method === 'GET' || r.path === 'api/admin/token')).toBe(true);
  });

  it('the same panel ignoring the parameter: nothing decided, fail closed as before', async () => {
    const panel = sellingPanel();
    panel.ignoresSort = true;
    const read = await fakeListSource(panel).source.read(SCOPE, PANEL_ID, {
      needed: needOf(needed),
    });
    if (read.ok && read.complete) {
      expect(read.resolution?.present).toBe(0);
      expect(read.resolution?.unresolved).toBe(6);
    } else {
      expect(read.ok && read.complete).toBe(false);
    }
  });
});

function indexCoversName(read: Complete, n: string): boolean {
  return read.index.covered === undefined || read.index.covered.has(n);
}
