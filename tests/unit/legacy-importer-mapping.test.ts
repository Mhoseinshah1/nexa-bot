import { describe, expect, it } from 'vitest';
import {
  PANEL_MAPPING_FORMAT,
  PanelMappingRefused,
  parsePanelMapping,
  unmappedCodePanels,
  validatePanelMappingAgainstTenant,
  type PanelFacts,
} from '../../apps/api/src/modules/platform/legacy-importer/application/panel-mapping';
import { syntheticMappingFile } from '../fixtures/legacy/synthetic-support';

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
      }),
      TENANT,
    ).fingerprint;
    expect(reordered).toBe(one);
    const changed = parsePanelMapping(file({ testPanels: ['tst', 'tst2'] }), TENANT).fingerprint;
    expect(changed).not.toBe(one);
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

  it('reports the legacy codes the file does not mention', () => {
    expect(
      Object.fromEntries(
        unmappedCodePanels(['rp1', 'zzz', ' zzz ', null, '', 'tst', 'gone', 'yyy'], mapping),
      ),
    ).toEqual({ zzz: 2, yyy: 1 });
  });
});
