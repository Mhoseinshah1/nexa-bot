/**
 * SYNTHETIC — helpers that put the synthetic legacy dataset in front of the importer:
 * the mapping file it is meant to be read with, and the panel inventories it assumes.
 * Not evidence (see `synthetic-legacy.ts`).
 */
import { PANEL_MAPPING_FORMAT } from '../../../apps/api/src/modules/platform/legacy-importer/application/panel-mapping';
import type {
  AccountRuntime,
  LegacyInventoryRead,
} from '../../../apps/api/src/modules/platform/legacy-importer/application/ports';
import { SYNTHETIC_PANEL_ACCOUNTS, SYNTHETIC_PANEL_CODES } from './synthetic-legacy';

/** A stand-in NEXA product id for the dataset's named legacy product `p1` (unit tests). */
export const SYNTHETIC_P1_PRODUCT = '0193aaaa-0000-7000-8000-000000000001';

/**
 * The mapping file for the dataset, given the NEXA ids of RickPanel A and B and the NEXA
 * product the legacy `p1` renews as (the owner's explicit product map, P6 ask 2).
 */
export function syntheticMappingFile(
  tenantId: string,
  panelA: string,
  panelB: string,
  p1Product: string | null = SYNTHETIC_P1_PRODUCT,
  /**
   * WP-D2: the fixture's deliberately unmapped code (`zzz`) is DECLARED unresolved, so a
   * synthetic audit is READY; pass false to see the audit BLOCK on a forgotten code.
   */
  declareUnmapped = true,
): string {
  return JSON.stringify(
    {
      format: PANEL_MAPPING_FORMAT,
      tenantId,
      panels: [
        { codePanel: SYNTHETIC_PANEL_CODES.mappedA, panelId: panelA },
        { codePanel: SYNTHETIC_PANEL_CODES.mappedB, panelId: panelB },
      ],
      testPanels: [SYNTHETIC_PANEL_CODES.test],
      missingPanels: [SYNTHETIC_PANEL_CODES.declaredMissing],
      ...(declareUnmapped
        ? {
            unresolvedPanels: [
              { codePanel: SYNTHETIC_PANEL_CODES.unmapped, reason: 'OWNER_DECIDES_LATER' },
            ],
          }
        : {}),
      productionPanels: [panelA, panelB],
      products: p1Product === null ? [] : [{ codeProduct: 'p1', productId: p1Product }],
    },
    null,
    2,
  );
}

function index(panelId: string, names: readonly string[]): LegacyInventoryRead {
  const usernames = new Map<string, string[]>();
  const runtime = new Map<string, AccountRuntime>();
  for (const name of names) {
    const key = name.toLowerCase();
    usernames.set(key, [...(usernames.get(key) ?? []), name].sort());
    runtime.set(name, {
      state: 'active',
      usage: { usedBytes: 0n, totalBytes: null, expiresAt: null },
      subscriptionUrl: null,
    });
  }
  return {
    ok: true,
    complete: true,
    index: { panelId, usernames },
    accounts: names.length,
    states: { active: names.length },
    runtime,
    observedAt: new Date('2026-10-04T00:00:00.000Z'),
  };
}

/** The inventories the dataset assumes, as complete reads. */
export function syntheticInventories(
  panelA: string,
  panelB: string,
): Map<string, LegacyInventoryRead> {
  return new Map([
    [panelA, index(panelA, SYNTHETIC_PANEL_ACCOUNTS.A)],
    [panelB, index(panelB, SYNTHETIC_PANEL_ACCOUNTS.B)],
  ]);
}
