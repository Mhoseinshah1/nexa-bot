import { describe, expect, it } from 'vitest';
import {
  PANEL_MAPPING_FORMAT,
  PanelMappingRefused,
  parsePanelMapping,
  INVALID_CODE_PANEL_KEY,
  UNRESOLVED_PANEL_REASONS,
  panelMappingCompleteness,
  unmappedCodePanels,
  validatePanelMappingAgainstTenant,
  validateProductMappingAgainstTenant,
  type PanelFacts,
} from '../../apps/api/src/modules/platform/legacy-importer/application/panel-mapping';
import { SYNTHETIC_P1_PRODUCT, syntheticMappingFile } from '../fixtures/legacy/synthetic-support';

/**
 * Item 6 — the panel mapping file (`docs/legacy-migration/importer.md` §Panel mapping):
 * explicit only, validated against the tenant before any run, fingerprinted canonically.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function file(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...JSON.parse(syntheticMappingFile(TENANT, A, B)), ...overrides });
}

function refusal(text: string): readonly string[] {
  try {
    parsePanelMapping(text, TENANT);
  } catch (error) {
    if (error instanceof PanelMappingRefused) return error.problems;
    throw error;
  }
  throw new Error('expected a refusal');
}

const panel = (id: string, over: Partial<PanelFacts> = {}): PanelFacts => ({
  id,
  tenantId: TENANT,
  providerType: 'rickpanel',
  status: 'ACTIVE',
  archived: false,
  ...over,
});

describe('parsing', () => {
  it('builds the matcher policy from the file', () => {
    const mapping = parsePanelMapping(file(), TENANT);
    expect(mapping.policy.knownPanels).toEqual(
      new Map([
        ['rp1', A],
        ['rp2', B],
      ]),
    );
    expect([...mapping.policy.testPanels]).toEqual(['tst']);
    expect([...mapping.policy.missingPanels]).toEqual(['gone']);
    expect(mapping.policy.productionPanelIds).toEqual([A, B]);
    expect(mapping.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('refuses any field it does not declare — an inbound id above all', () => {
    expect(refusal(file({ inboundId: 3 })).join()).toMatch(/inboundId|Unrecognized/u);
    expect(
      refusal(file({ panels: [{ codePanel: 'rp1', panelId: A, inboundid: '2' }] })).join(),
    ).toMatch(/Unrecognized|inboundid/u);
    expect(refusal(file({ format: 'v0' })).length).toBeGreaterThan(0);
    expect(refusal('not json')).toEqual(['the file is not JSON']);
  });

  it('refuses a code in two lists, a code twice, and a mapped panel outside production', () => {
    expect(refusal(file({ testPanels: ['rp1'] })).join()).toMatch(/both panels and testPanels/u);
    expect(refusal(file({ missingPanels: ['gone', 'gone'] })).join()).toMatch(/twice/u);
    expect(refusal(file({ productionPanels: [A] })).join()).toMatch(/not in productionPanels/u);
    expect(refusal(file({ productionPanels: [A, B, A] })).join()).toMatch(/twice/u);
    expect(refusal(file({ tenantId: '22222222-2222-4222-8222-222222222222' })).join()).toMatch(
      /tenantId/u,
    );
    expect(refusal(file({ testPanels: [' tst'] })).length).toBeGreaterThan(0);
    expect(refusal(file({ productionPanels: ['A'] })).length).toBeGreaterThan(0);
  });

  it('fingerprints the meaning, not the formatting', () => {
    const one = parsePanelMapping(file(), TENANT).fingerprint;
    const reordered = parsePanelMapping(
      JSON.stringify({
        productionPanels: [B, A],
        missingPanels: ['gone'],
        testPanels: ['tst'],
        panels: [
          { panelId: B, codePanel: 'rp2' },
          { codePanel: 'rp1', panelId: A },
        ],
        tenantId: TENANT,
        format: PANEL_MAPPING_FORMAT,
        products: [{ productId: SYNTHETIC_P1_PRODUCT, codeProduct: 'p1' }],
        unresolvedPanels: [{ reason: 'OWNER_DECIDES_LATER', codePanel: 'zzz' }],
      }),
      TENANT,
    ).fingerprint;
    expect(reordered).toBe(one);
    const changed = parsePanelMapping(file({ testPanels: ['tst', 'tst2'] }), TENANT).fingerprint;
    expect(changed).not.toBe(one);
    // The product map is part of the meaning: a different target or no map at all is a
    // different mapping, so a run cannot resume under a product map it did not start with.
    const other = parsePanelMapping(
      file({ products: [{ codeProduct: 'p1', productId: A }] }),
      TENANT,
    ).fingerprint;
    const none = parsePanelMapping(file({ products: [] }), TENANT).fingerprint;
    expect(new Set([one, other, none]).size).toBe(3);
  });

  it('refuses a product code twice, a non-uuid product and a code that is not exact', () => {
    const p = (codeProduct: string, productId: string) => ({ codeProduct, productId });
    expect(refusal(file({ products: [p('p1', A), p('p1', B)] })).join()).toMatch(/p1.*twice/u);
    expect(refusal(file({ products: [p('p1', 'not-a-uuid')] })).length).toBeGreaterThan(0);
    expect(refusal(file({ products: [p(' p1', A)] })).length).toBeGreaterThan(0);
    expect(refusal(file({ products: [{ ...p('p1', A), price: 1 }] })).length).toBeGreaterThan(0);
  });
});

describe('validation against the tenant', () => {
  const mapping = parsePanelMapping(file(), TENANT);

  it('accepts ACTIVE RickPanels of this tenant', () => {
    expect(() => validatePanelMappingAgainstTenant(mapping, [panel(A), panel(B)])).not.toThrow();
  });

  for (const [name, facts, message] of [
    ['missing', [panel(A)], /does not exist/u],
    ['another tenant', [panel(A), panel(B, { tenantId: 'other' })], /does not exist/u],
    ['not a RickPanel', [panel(A), panel(B, { providerType: 'marzban' })], /not a RickPanel/u],
    ['disabled', [panel(A), panel(B, { status: 'DISABLED' })], /not ACTIVE/u],
    ['archived', [panel(A), panel(B, { archived: true })], /ARCHIVED/u],
  ] as const) {
    it(`refuses a panel that is ${name}`, () => {
      expect(() => validatePanelMappingAgainstTenant(mapping, facts)).toThrow(message);
    });
  }

  it('accepts a product map naming products of this tenant, refuses one that does not', () => {
    expect(mapping.products).toEqual(new Map([['p1', SYNTHETIC_P1_PRODUCT]]));
    expect(() =>
      validateProductMappingAgainstTenant(mapping, new Set([SYNTHETIC_P1_PRODUCT])),
    ).not.toThrow();
    expect(() => validateProductMappingAgainstTenant(mapping, new Set())).toThrow(
      /p1.*does not exist in this tenant/u,
    );
  });

  it('reports the legacy codes the file does not mention', () => {
    expect(
      Object.fromEntries(
        unmappedCodePanels(['rp1', 'zzz', ' zzz ', null, '', 'tst', 'gone', 'yyy'], mapping),
      ),
    ).toEqual({ zzz: 2, yyy: 1 });
  });

  it('a source code that no mapping file could name is counted under one bounded placeholder', () => {
    const counted = Object.fromEntries(
      unmappedCodePanels(
        ['zzz', 'x'.repeat(201), 'a\u0000b', 'two\nlines', 'tab\there', 'x'.repeat(200)],
        mapping,
      ),
    );
    expect(counted).toEqual({
      zzz: 1,
      [INVALID_CODE_PANEL_KEY]: 4,
      ['x'.repeat(200)]: 1,
    });
    expect(INVALID_CODE_PANEL_KEY.length).toBeLessThanOrEqual(40);
  });
});

describe('WP-D2: unresolvedPanels and completeness (G10)', () => {
  const live = (codePanel: string | null, isTest = '0') => ({ codePanel, isTest });

  it('keeps the fingerprint of every v1 map written before the key existed', () => {
    // Computed by the code on main before WP-D2 (edd13981) over this exact file.
    const v1 = JSON.stringify({
      format: PANEL_MAPPING_FORMAT,
      tenantId: TENANT,
      panels: [
        { codePanel: 'rp1', panelId: A },
        { codePanel: 'rp2', panelId: B },
      ],
      testPanels: ['tst'],
      missingPanels: ['gone'],
      productionPanels: [A, B],
      products: [{ codeProduct: 'p1', productId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }],
    });
    const pinned = '75005ea8c6a1d4552eef77bb11f47b047f31c2ed91c4ddda1069cd19d17c5c1f';
    expect(parsePanelMapping(v1, TENANT).fingerprint).toBe(pinned);
    // An empty list means the same as no list.
    const empty = JSON.stringify({ ...JSON.parse(v1), unresolvedPanels: [] });
    expect(parsePanelMapping(empty, TENANT).fingerprint).toBe(pinned);
    // A declaration changes the meaning, so it changes the fingerprint — and the reason
    // is part of it.
    const declared = (reason: string) =>
      parsePanelMapping(
        JSON.stringify({ ...JSON.parse(v1), unresolvedPanels: [{ codePanel: 'zzz', reason }] }),
        TENANT,
      ).fingerprint;
    expect(declared('OWNER_DECIDES_LATER')).not.toBe(pinned);
    expect(declared('OWNER_DECIDES_LATER')).not.toBe(declared('UNKNOWN_ORIGIN'));
  });

  it('takes a closed reason only, and no other key', () => {
    expect(UNRESOLVED_PANEL_REASONS).toEqual([
      'OWNER_DECIDES_LATER',
      'DECOMMISSIONED_PANEL',
      'UNKNOWN_ORIGIN',
    ]);
    expect(
      refusal(file({ unresolvedPanels: [{ codePanel: 'zzz', reason: 'maybe rp1' }] })),
    ).toEqual([expect.stringMatching(/^unresolvedPanels\.0\.reason:/u)]);
    expect(
      refusal(
        file({ unresolvedPanels: [{ codePanel: 'zzz', reason: 'UNKNOWN_ORIGIN', panelId: A }] }),
      ),
    ).toEqual([expect.stringMatching(/^unresolvedPanels\.0:.*panelId/u)]);
  });

  it('refuses an unresolved code that is also mapped, tested, missing, or declared twice', () => {
    for (const code of ['rp1', 'tst', 'gone']) {
      expect(
        refusal(file({ unresolvedPanels: [{ codePanel: code, reason: 'UNKNOWN_ORIGIN' }] })),
      ).toEqual([expect.stringContaining(`${JSON.stringify(code)} is in both`)]);
    }
    expect(
      refusal(
        file({
          unresolvedPanels: [
            { codePanel: 'zzz', reason: 'UNKNOWN_ORIGIN' },
            { codePanel: 'zzz', reason: 'OWNER_DECIDES_LATER' },
          ],
        }),
      ),
    ).toEqual(['code_panel "zzz" appears twice in unresolvedPanels']);
  });

  it('an unresolved code matches nothing: it is in no list the matcher reads', () => {
    const declared = parsePanelMapping(file(), TENANT);
    expect(declared.unresolved).toEqual(new Map([['zzz', 'OWNER_DECIDES_LATER']]));
    expect(declared.policy.knownPanels.has('zzz')).toBe(false);
    expect(declared.policy.testPanels.has('zzz')).toBe(false);
    expect(declared.policy.missingPanels.has('zzz')).toBe(false);
  });

  it('is complete when every live real code is accounted for; a declared code is counted, not blocking', () => {
    const mapping = parsePanelMapping(file(), TENANT);
    const result = panelMappingCompleteness(
      [live('rp1'), live('rp1'), live('rp2'), live('tst'), live('gone'), live('zzz'), live(null)],
      mapping,
    );
    expect(result).toEqual({
      complete: true,
      unmapped: {},
      declaredUnresolved: { zzz: { reason: 'OWNER_DECIDES_LATER', liveRealInvoices: 1 } },
      stale: [],
      productionPanelsUnreferenced: [],
    });
  });

  it('is INCOMPLETE on a code no list names, with the code and its count', () => {
    const forgot = parsePanelMapping(syntheticMappingFile(TENANT, A, B, null, false), TENANT);
    const result = panelMappingCompleteness(
      [live('rp1'), live('rp2'), live('zzz'), live(' zzz '), live('yyy'), live('yyy', '1')],
      forgot,
    );
    expect(result.complete).toBe(false);
    // A test invoice's code is not a live REAL code: it decides nothing about completeness.
    expect(result.unmapped).toEqual({ zzz: 2, yyy: 1 });
    expect(result.declaredUnresolved).toEqual({});
  });

  it('source codes no file could name block until their placeholder is declared', () => {
    const live2 = [live('rp1'), live('a\u0000b'), live('two\nlines')];
    expect(panelMappingCompleteness(live2, parsePanelMapping(file(), TENANT)).unmapped).toEqual({
      [INVALID_CODE_PANEL_KEY]: 2,
    });
    const declared = parsePanelMapping(
      file({
        unresolvedPanels: [
          { codePanel: 'zzz', reason: 'OWNER_DECIDES_LATER' },
          { codePanel: INVALID_CODE_PANEL_KEY, reason: 'UNKNOWN_ORIGIN' },
        ],
      }),
      TENANT,
    );
    const result = panelMappingCompleteness(live2, declared);
    expect(result.complete).toBe(true);
    expect(result.declaredUnresolved[INVALID_CODE_PANEL_KEY]).toEqual({
      reason: 'UNKNOWN_ORIGIN',
      liveRealInvoices: 2,
    });
    // Present under its placeholder, so never stale itself.
    expect(result.stale).not.toContain(INVALID_CODE_PANEL_KEY);
    expect(result.stale).toEqual(['gone', 'rp2', 'tst', 'zzz']);
  });

  it('reports stale map entries and production panels no live code points at', () => {
    const mapping = parsePanelMapping(file(), TENANT);
    const result = panelMappingCompleteness([live('rp1'), live('rp2', '1')], mapping);
    expect(result.complete).toBe(true);
    // rp2 is carried by a live TEST invoice only: not stale, but panel B is unreferenced.
    expect(result.stale).toEqual(['gone', 'tst', 'zzz']);
    expect(result.productionPanelsUnreferenced).toEqual([B]);
    expect(result.declaredUnresolved).toEqual({
      zzz: { reason: 'OWNER_DECIDES_LATER', liveRealInvoices: 0 },
    });
  });
});
