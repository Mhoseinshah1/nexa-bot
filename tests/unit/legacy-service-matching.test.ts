import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  matchLegacyService,
  type LegacyPanelPolicy,
  type PanelInventoryIndex,
} from '../../apps/api/src/modules/platform/legacy-import/application/legacy-service-matching';

/**
 * Migration P5's matching rule (§11, §19): known panel → explicit map + lower(username);
 * missing panel → exact lowercase username across configured RickPanels, 1 → eligible,
 * 0 → PROVIDER_MISSING, >1 → AMBIGUOUS_PANEL. No other guessing, never the inbound id.
 */

const P1 = '00000000-0000-4000-8000-0000000000a1';
const P2 = '00000000-0000-4000-8000-0000000000b2';
const P3 = '00000000-0000-4000-8000-0000000000c3';

const policy: LegacyPanelPolicy = {
  knownPanels: new Map([
    ['germany', P1],
    ['finland', P2],
  ]),
  testPanels: new Set(['TEST_MARZBAN_RICKPANEL']),
  missingPanels: new Set(['old-netherlands']),
  productionPanelIds: [P1, P2, P3],
};

const index = (panelId: string, names: string[]): PanelInventoryIndex => ({
  panelId,
  // Built the way `inventoryIndex` builds it: lowercase key → exact spellings, sorted.
  usernames: names.reduce((map, name) => {
    const key = name.toLowerCase();
    map.set(key, [...(map.get(key) ?? []), name].sort());
    return map;
  }, new Map<string, string[]>()),
});

const inventories = new Map<string, PanelInventoryIndex>([
  [P1, index(P1, ['Alice', 'shared'])],
  [P2, index(P2, ['bob', 'shared'])],
  [P3, index(P3, ['carol'])],
]);

describe('panel known', () => {
  it('matches lower(username) on the mapped panel only', () => {
    expect(
      matchLegacyService({ codePanel: 'germany', username: 'ALICE' }, policy, inventories),
    ).toEqual({
      kind: 'ELIGIBLE',
      panelId: P1,
      username: 'alice',
      // The panel's own spelling, which is what an adoption must store (C3).
      providerUsername: 'Alice',
    });
  });

  it('a name present on ANOTHER panel is not a match for a known panel', () => {
    expect(
      matchLegacyService({ codePanel: 'germany', username: 'bob' }, policy, inventories),
    ).toEqual({
      kind: 'MANUAL_REVIEW',
      reason: 'PROVIDER_MISSING',
      candidatePanels: 0,
    });
  });

  it('an incomplete inventory for the mapped panel is UNDECIDABLE, never PROVIDER_MISSING', () => {
    const partial = new Map(inventories);
    partial.delete(P1);
    expect(
      matchLegacyService({ codePanel: 'germany', username: 'alice' }, policy, partial),
    ).toEqual({
      kind: 'UNDECIDABLE',
      reason: 'INVENTORY_INCOMPLETE',
    });
  });
});

describe('panel missing', () => {
  it('exactly one configured panel holds the name: eligible there', () => {
    for (const codePanel of [null, 'old-netherlands']) {
      expect(matchLegacyService({ codePanel, username: 'Carol' }, policy, inventories)).toEqual({
        kind: 'ELIGIBLE',
        panelId: P3,
        username: 'carol',
        providerUsername: 'carol',
      });
    }
  });

  it('no panel holds it: PROVIDER_MISSING', () => {
    expect(matchLegacyService({ codePanel: null, username: 'zed' }, policy, inventories)).toEqual({
      kind: 'MANUAL_REVIEW',
      reason: 'PROVIDER_MISSING',
      candidatePanels: 0,
    });
  });

  it('several panels hold it: AMBIGUOUS_PANEL, never a pick', () => {
    expect(
      matchLegacyService({ codePanel: null, username: 'shared' }, policy, inventories),
    ).toEqual({
      kind: 'MANUAL_REVIEW',
      reason: 'AMBIGUOUS_PANEL',
      candidatePanels: 2,
    });
  });

  it('any production panel without a complete inventory makes it UNDECIDABLE', () => {
    const partial = new Map(inventories);
    partial.delete(P2);
    expect(matchLegacyService({ codePanel: null, username: 'carol' }, policy, partial)).toEqual({
      kind: 'UNDECIDABLE',
      reason: 'INVENTORY_INCOMPLETE',
    });
  });

  it('a panel listed twice is searched once', () => {
    const twice = { ...policy, productionPanelIds: [P3, P3] };
    expect(
      matchLegacyService({ codePanel: null, username: 'carol' }, twice, inventories),
    ).toMatchObject({
      kind: 'ELIGIBLE',
    });
  });
});

describe('Codex review of #169', () => {
  it('P2: a test-panel row is skipped even when its username is invalid or empty', () => {
    for (const username of ['', 'with space', 'ﾑ']) {
      expect(
        matchLegacyService({ codePanel: 'TEST_MARZBAN_RICKPANEL', username }, policy, inventories),
      ).toEqual({ kind: 'SKIPPED', reason: 'TEST_PANEL' });
    }
  });

  it('P2: two known holders are AMBIGUOUS even while a third panel is unavailable', () => {
    const partial = new Map(inventories);
    partial.delete(P3);
    expect(matchLegacyService({ codePanel: null, username: 'shared' }, policy, partial)).toEqual({
      kind: 'MANUAL_REVIEW',
      reason: 'AMBIGUOUS_PANEL',
      candidatePanels: 2,
    });
  });

  it('P2: one known holder plus an unavailable panel is still UNDECIDABLE', () => {
    const partial = new Map(inventories);
    partial.delete(P2);
    expect(matchLegacyService({ codePanel: null, username: 'carol' }, policy, partial)).toEqual({
      kind: 'UNDECIDABLE',
      reason: 'INVENTORY_INCOMPLETE',
    });
  });

  it('P2: two spellings of one name on one panel are a case collision, never eligible', () => {
    const colliding = new Map(inventories);
    colliding.set(P1, index(P1, ['Dora', 'dora']));
    colliding.set(P3, index(P3, ['Erin', 'erin']));
    expect(
      matchLegacyService({ codePanel: 'germany', username: 'dora' }, policy, colliding),
    ).toEqual({ kind: 'MANUAL_REVIEW', reason: 'USERNAME_CASE_COLLISION', candidatePanels: 1 });
    expect(matchLegacyService({ codePanel: null, username: 'ERIN' }, policy, colliding)).toEqual({
      kind: 'MANUAL_REVIEW',
      reason: 'USERNAME_CASE_COLLISION',
      candidatePanels: 1,
    });
  });
});

describe('everything else', () => {
  it('a test panel row is skipped', () => {
    expect(
      matchLegacyService(
        { codePanel: 'TEST_MARZBAN_RICKPANEL', username: 'alice' },
        policy,
        inventories,
      ),
    ).toEqual({ kind: 'SKIPPED', reason: 'TEST_PANEL' });
  });

  it('an unmapped, non-missing code_panel is PANEL_UNMAPPED — not searched', () => {
    expect(
      matchLegacyService({ codePanel: 'forgotten', username: 'carol' }, policy, inventories),
    ).toEqual({
      kind: 'MANUAL_REVIEW',
      reason: 'PANEL_UNMAPPED',
      candidatePanels: 0,
    });
  });

  it('a username it will not compare is INVALID', () => {
    for (const username of ['', 'with space', 'ﾑ']) {
      expect(matchLegacyService({ codePanel: 'germany', username }, policy, inventories)).toEqual({
        kind: 'INVALID',
        reason: 'INVALID_SOURCE_ROW',
      });
    }
  });

  it('source: the matcher never reads an inbound id', () => {
    const source = readFileSync(
      new URL(
        '../../apps/api/src/modules/platform/legacy-import/application/legacy-service-matching.ts',
        import.meta.url,
      ),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/inbound/i);
  });
});
