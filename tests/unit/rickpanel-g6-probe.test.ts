import { describe, expect, it } from 'vitest';
import {
  compareOtherLimit,
  compareSameOffset,
  g6ProbeExitCode,
  probePanelG6,
  probeWireCounter,
  type G6ProbeReport,
} from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/rickpanel-g6-probe';
import {
  RickpanelInventorySource,
  walkOverlap,
} from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/rickpanel-inventory-source';
import { InProcessPanelReadGate } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/panel-read-gate';
import {
  ProbeArgsError,
  parseProbeArgs,
  probeSummaryLine,
} from '../../apps/api/src/rickpanel-probe.cli';
import {
  FAKE_PASSWORD,
  FAKE_TOKEN,
  appendAccount,
  fakeListPanel,
  fakeListSource,
  fakeName as name,
  type FakeListPanel,
} from '../support/fake-rickpanel-list';

/**
 * Gate G6 — the bounded, read-only probe (`rickpanel-g6-probe.ts`, `rickpanel-probe.cli.ts`),
 * against the SYNTHETIC fake list: each variant a real RickPanel might turn out to be is
 * classified as what it is. Mechanics only — never evidence about RickPanel.
 */

const SCOPE = { tenantId: '11111111-1111-4111-8111-111111111111' } as never;
const PANEL_ID = '019600ab-cdef-7012-8345-6789abcd0401';

async function probe(
  panel: FakeListPanel,
  options: { walks?: number; maxPages?: number; maxWallMs?: number; pageSize?: number } = {},
  sourceOptions: Record<string, unknown> = {},
): Promise<G6ProbeReport> {
  const { source } = fakeListSource(panel, sourceOptions);
  const result = await probePanelG6(
    source,
    SCOPE,
    PANEL_ID,
    { pageSize: 100, ...options },
    walkOverlap,
  );
  if (!result.ok) throw new Error(result.failure);
  return result.report;
}

const onlyReads = (panel: FakeListPanel) =>
  panel.log.every(
    (r) =>
      (r.method === 'GET' && r.path.startsWith('api/users?')) ||
      (r.method === 'POST' && r.path === 'api/admin/token'),
  );

describe('G6 probe: a panel that meets every assumption', () => {
  it('a still panel: G6 holds, every walk decisive, exit 0, reads only, one login, paced', async () => {
    const panel = fakeListPanel(300);
    const report = await probe(panel);
    expect(report.verdict).toBe('G6_HOLDS');
    expect(report.findings).toEqual([]);
    expect(g6ProbeExitCode(report)).toBe(0);
    expect(report.shape).toEqual({
      listShape: 'USERS_AND_TOTAL',
      pageSizeAsked: 100,
      firstPageRows: 100,
      learnedLimit: null,
    });
    expect(report.order).toEqual({ sameOffsetTwice: 'IDENTICAL', otherLimitOverlap: 'CONSISTENT' });
    expect(report.walks.map((w) => [w.gapFree, w.decisive])).toEqual([
      [true, true],
      [true, true],
      [true, true],
    ]);
    // 3 sample pages + 3 walks of 4 pages.
    expect(report.wire).toEqual({ login: 1, listPage: 15, other: 0, refusedWrites: 0 });
    expect(report.readOnly).toBe(true);
    expect(onlyReads(panel)).toBe(true);
    expect(panel.log.filter((r) => r.method === 'POST')).toHaveLength(1);
    // Paced by the read session: at least the interval between two requests.
    expect(report.load.requests).toBe(16);
    expect(report.load.durationMs).toBeGreaterThanOrEqual(15 * 1000);
    expect(report.churn.totalChangePerMinute).toBe(0);
  });

  it('a panel that keeps selling: CHURN, measured per minute, and G6 still holds', async () => {
    const panel = fakeListPanel(300);
    panel.beforePage = (_o, page) => {
      if (page % 3 === 0) appendAccount(panel, `zz-sale-${String(page)}`);
    };
    const report = await probe(panel);
    expect(report.findings).toEqual(['CHURN']);
    expect(report.verdict).toBe('G6_HOLDS');
    expect(report.total.maxChange).toBeGreaterThan(0);
    expect(report.churn.totalChangePerMinute).toBeGreaterThan(0);
    expect(report.churn.addedPerMinute).toBeGreaterThan(0);
    expect(report.churn.removedPerMinute).toBe(0);
  });

  it('a page cap: PAGE_CAP and the learned limit, not a failure', async () => {
    const panel = fakeListPanel(300);
    panel.cap = 50;
    const report = await probe(panel);
    expect(report.shape.learnedLimit).toBe(50);
    expect(report.findings).toEqual(['PAGE_CAP']);
    expect(report.verdict).toBe('G6_HOLDS');
  });
});

describe('G6 probe: each broken assumption, classified', () => {
  it('rows without created_at', async () => {
    const panel = fakeListPanel(300);
    panel.createdAtOf = () => undefined;
    const report = await probe(panel);
    expect(report.createdAt).toMatchObject({ rows: 100, rowsWithout: 100 });
    expect(report.findings).toEqual(
      expect.arrayContaining(['CREATED_AT_MISSING', 'NO_GAP_FREE_WALK', 'NO_DECISIVE_WALK']),
    );
    expect(report.verdict).toBe('G6_FAILS');
    expect(g6ProbeExitCode(report)).toBe(1);
    expect(report.walks[0]?.firstFailure).toEqual({ kind: 'CREATED_ORDER', pageIndex: 0 });
  });

  it('one row out of creation order', async () => {
    const panel = fakeListPanel(300);
    panel.created.set(name(50), 3);
    const report = await probe(panel);
    expect(report.createdAt.inversions).toBe(1);
    expect(report.findings).toEqual(
      expect.arrayContaining(['CREATED_AT_OUT_OF_ORDER', 'NO_GAP_FREE_WALK']),
    );
    expect(report.findings).not.toContain('CREATED_AT_MISSING');
    expect(report.verdict).toBe('G6_FAILS');
  });

  it('epoch numbers for created_at', async () => {
    const panel = fakeListPanel(300);
    panel.createdAtOf = (_u, s) => 1_767_225_600 + s;
    const report = await probe(panel);
    expect(report.createdAt.formats).toEqual({ EPOCH_LIKE: 100 });
    expect(report.findings).toEqual(
      expect.arrayContaining(['CREATED_AT_EPOCH', 'CREATED_AT_UNPARSABLE']),
    );
    expect(report.verdict).toBe('G6_FAILS');
  });

  it('no total', async () => {
    const panel = fakeListPanel(300);
    panel.noTotal = true;
    const report = await probe(panel);
    expect(report.shape.listShape).toBe('USERS_ONLY');
    expect(report.total.pagesWithTotal).toBe(0);
    expect(report.findings).toEqual(expect.arrayContaining(['NO_TOTAL', 'NO_GAP_FREE_WALK']));
    expect(report.walks.every((w) => w.failures.includes('NO_TOTAL'))).toBe(true);
    expect(report.verdict).toBe('G6_FAILS');
  });

  it('an order that changes between two requests of the same offset', async () => {
    const panel = fakeListPanel(300);
    panel.view = (rows, _o, _l, page) => (page === 1 ? [...rows].reverse() : rows);
    const report = await probe(panel);
    expect(report.order.sameOffsetTwice).toBe('SAME_ROWS_OTHER_ORDER');
    expect(report.findings).toContain('ORDER_UNSTABLE_SAME_OFFSET');
    expect(report.verdict).toBe('G6_FAILS');
  });

  it('an order that depends on the limit asked', async () => {
    const panel = fakeListPanel(300);
    panel.view = (rows, _o, limit) => (limit === 100 ? rows : [...rows].reverse());
    const report = await probe(panel);
    expect(report.order.otherLimitOverlap).toBe('INCONSISTENT');
    expect(report.findings).toContain('ORDER_UNSTABLE_OTHER_LIMIT');
    expect(report.verdict).toBe('G6_FAILS');
  });

  it('an order unstable on every request: no walk gap-free, none in one order', async () => {
    const panel = fakeListPanel(300);
    panel.view = (rows, _o, _l, page) => (page % 2 === 1 ? [...rows].reverse() : rows);
    const report = await probe(panel);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        'ORDER_UNSTABLE_SAME_OFFSET',
        'NO_GAP_FREE_WALK',
        'NO_DECISIVE_WALK',
      ]),
    );
    expect(
      report.walks.some((w) => w.chainBreaks.some((b) => b.code === 'COMMON_ORDER_DIFFERS')),
    ).toBe(true);
  });

  it('deletion bursts in every walk: no decisive walk, and the churn is measured', async () => {
    const panel = fakeListPanel(400);
    panel.beforePage = (_o, page) => {
      // Sample pages 0-2; each walk is 5 pages (3-7, 8-12, 13-17): a burst on its 2nd.
      if (page === 4 || page === 9 || page === 14) panel.names.splice(0, 15);
    };
    const report = await probe(panel);
    expect(report.findings).toEqual(expect.arrayContaining(['CHURN', 'NO_DECISIVE_WALK']));
    expect(report.churn.removedPerMinute).toBeGreaterThan(0);
    expect(report.walks.every((w) => w.chainBreaks.some((b) => b.code === 'NO_COMMON_ROW'))).toBe(
      true,
    );
    expect(report.verdict).toBe('G6_FAILS');
  });
});

describe('G6 probe: what a moving panel can and cannot settle', () => {
  // Sample pages 0-2; 300 accounts walk in 4 pages each: walks at 3-6, 7-10, 11-14.
  it('one deletion burst in the middle walk: a decision walk and a decisive last walk — holds', async () => {
    const panel = fakeListPanel(300);
    panel.beforePage = (_o, page) => {
      if (page === 8) panel.names.splice(0, 15);
    };
    const report = await probe(panel);
    expect(report.walks.map((w) => w.decisive)).toEqual([true, false, true]);
    expect(report.verdict).toBe('G6_HOLDS');
  });

  it('bursts in the first two walks: only the last is decisive, nothing to decide from — fails', async () => {
    const panel = fakeListPanel(300);
    panel.beforePage = (_o, page) => {
      if (page === 4 || page === 8) panel.names.splice(0, 15);
    };
    const report = await probe(panel);
    expect(report.walks.map((w) => w.decisive)).toEqual([false, false, true]);
    expect(report.verdict).toBe('G6_FAILS');
  });

  it('a list that is not a page: NOT_A_PAGE, a conclusion, not an inconclusive run', async () => {
    const panel = fakeListPanel(30);
    panel.bareArray = true;
    const report = await probe(panel);
    expect(report.shape.listShape).toBe('NOT_A_PAGE');
    expect(report.findings).toEqual(['NOT_A_PAGE']);
    expect(report.verdict).toBe('G6_FAILS');
    expect(report.wire.listPage).toBe(1);
  });
});

describe('G6 probe: the order comparisons', () => {
  it('the same offset twice', () => {
    expect(compareSameOffset(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe('IDENTICAL');
    // A sale appended to a list shorter than a page.
    expect(compareSameOffset(['a', 'b'], ['a', 'b', 'c'])).toBe('IDENTICAL');
    expect(compareSameOffset(['a', 'b', 'c'], ['c', 'a', 'b'])).toBe('SAME_ROWS_OTHER_ORDER');
    // A deletion at the head between the two requests.
    expect(compareSameOffset(['a', 'b', 'c'], ['b', 'c', 'd'])).toBe('DIFFERENT_ROWS');
  });

  it('an overlapping page with another limit', () => {
    const a = ['a', 'b', 'c', 'd', 'e', 'f'];
    expect(compareOtherLimit(a, 3, ['d', 'e', 'f', 'g'])).toBe('CONSISTENT');
    // One row deleted ahead of them between the two requests: all moved by one.
    expect(compareOtherLimit(a, 3, ['e', 'f', 'g'])).toBe('SHIFTED');
    expect(compareOtherLimit(a, 3, ['f', 'e', 'd'])).toBe('INCONSISTENT');
    expect(compareOtherLimit(a, 3, ['x', 'y'])).toBe('NOT_TESTABLE');
  });

  it('rows that moved between the two requests are informational: a busy panel still holds', async () => {
    const panel = fakeListPanel(300);
    panel.beforePage = (_o, page) => {
      if (page === 1) panel.names.splice(0, 1);
    };
    const report = await probe(panel);
    expect(report.order.sameOffsetTwice).toBe('DIFFERENT_ROWS');
    expect(report.findings).toContain('ROWS_CHANGED_SAME_OFFSET');
    expect(report.verdict).toBe('G6_HOLDS');
  });
});

describe('G6 probe: bounded', () => {
  it('stops at its page cap before sending more, and says it is inconclusive', async () => {
    const panel = fakeListPanel(300);
    const report = await probe(panel, { maxPages: 5 });
    expect(report.budget).toMatchObject({ maxPages: 5, pagesUsed: 5, stoppedBy: 'PAGES' });
    expect(panel.log.filter((r) => r.method === 'GET')).toHaveLength(5);
    expect(report.verdict).toBe('INCONCLUSIVE');
    expect(g6ProbeExitCode(report)).toBe(3);
  });

  it('stops at its wall-time cap (the paced clock), before the next request', async () => {
    const panel = fakeListPanel(300);
    const report = await probe(panel, { maxWallMs: 6_000 });
    expect(report.budget.stoppedBy).toBe('WALL_TIME');
    // One request a second: the login and a handful of pages, never the whole probe.
    expect(panel.log.length).toBeLessThanOrEqual(7);
    expect(report.verdict).toBe('INCONCLUSIVE');
  });

  it('waits its turn behind another read of the same panel (the importer’s gate)', async () => {
    const gate = new InProcessPanelReadGate();
    const panel = fakeListPanel(30);
    const { source } = fakeListSource(panel, { gate });
    const held = await gate.acquire('https://panel-g6.invalid', undefined);
    let done = false;
    const running = probePanelG6(source, SCOPE, PANEL_ID, { pageSize: 10 }, walkOverlap).then(
      (r) => {
        done = true;
        return r;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(done).toBe(false);
    expect(panel.log).toHaveLength(0);
    await held.release();
    const result = await running;
    expect(result.ok).toBe(true);
  });

  it('a panel the installation cannot read is refused before any request', async () => {
    let sent = 0;
    const noCredential = new RickpanelInventorySource(
      {
        panel: async () => ({ baseUrl: 'https://panel-g6.invalid', providerType: 'rickpanel' }),
        credentials: async () => null,
        http: () => ({
          send: async () => {
            sent += 1;
            return { ok: false, failure: 'TIMEOUT', status: null };
          },
        }),
      },
      { gate: new InProcessPanelReadGate() },
      () => new Date(0),
    );
    expect(await probePanelG6(noCredential, SCOPE, PANEL_ID, {}, walkOverlap)).toEqual({
      ok: false,
      failure: 'CREDENTIALS_MISSING',
    });
    expect(sent).toBe(0);
  });
});

describe('G6 probe: read-only and aggregate-only', () => {
  it('prints no name, row stamp, token, password or address', async () => {
    const panel = fakeListPanel(300);
    panel.created.set(name(50), 3);
    const report = await probe(panel);
    const text = JSON.stringify(report) + probeSummaryLine(report);
    for (const secret of [
      'acc0',
      'zz-',
      FAKE_TOKEN,
      FAKE_PASSWORD,
      'panel-g6.invalid',
      '2026-01-01',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('the wire counter names anything but a login or a list page, and such a report never passes', async () => {
    const sent: string[] = [];
    const wire = probeWireCounter({
      send: async (r) => {
        sent.push(r.path);
        return { ok: false, failure: 'TIMEOUT', status: null };
      },
    });
    await wire.client.send({ method: 'POST', effect: 'READ', path: 'api/admin/token' } as never);
    await wire.client.send({
      method: 'GET',
      effect: 'READ',
      path: 'api/users?offset=0&limit=1',
    } as never);
    await wire.client.send({ method: 'GET', effect: 'READ', path: 'api/user/x' } as never);
    expect(wire.counts()).toEqual({ login: 1, listPage: 1, other: 1 });

    const report = await probe(fakeListPanel(30), { pageSize: 10 });
    expect(g6ProbeExitCode({ ...report, readOnly: false })).toBe(4);
  });
});

describe('rickpanel-probe CLI arguments', () => {
  it('parses the bounded options, with defaults', () => {
    expect(parseProbeArgs(['--panel', PANEL_ID])).toEqual({
      panelId: PANEL_ID,
      tenantSlug: null,
      pageSize: null,
      walks: 3,
      maxPages: 400,
      maxWallMs: 20 * 60_000,
    });
    expect(
      parseProbeArgs([
        '--panel',
        PANEL_ID,
        '--tenant',
        'main',
        '--page-size',
        '50',
        '--walks',
        '2',
        '--max-pages',
        '900',
        '--max-minutes',
        '45',
      ]),
    ).toEqual({
      panelId: PANEL_ID,
      tenantSlug: 'main',
      pageSize: 50,
      walks: 2,
      maxPages: 900,
      maxWallMs: 45 * 60_000,
    });
  });

  it('accepts any page size the reader itself accepts (up to 2000)', () => {
    expect(parseProbeArgs(['--panel', PANEL_ID, '--page-size', '2000']).pageSize).toBe(2000);
  });

  it.each([
    [[]],
    [['--panel']],
    [['--panel', PANEL_ID, '--walks', '4']],
    [['--panel', PANEL_ID, '--max-pages', '5001']],
    [['--panel', PANEL_ID, '--max-minutes', '91']],
    [['--panel', PANEL_ID, '--page-size', '0']],
    [['--panel', PANEL_ID, '--page-size', '2001']],
    [['--panel', PANEL_ID, '--write']],
    [['--panel', 'https://x', '--walks', '2']],
    [['--panel', PANEL_ID, '--panel', PANEL_ID]],
  ])('refuses %j', (argv) => {
    expect(() => parseProbeArgs(argv)).toThrow(ProbeArgsError);
  });
});
