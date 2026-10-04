/**
 * SYNTHETIC — helpers that put the synthetic legacy dataset in front of the importer:
 * the mapping file it is meant to be read with, and the panel inventories it assumes.
 * Not evidence (see `synthetic-legacy.ts`).
 */
import { PANEL_MAPPING_FORMAT } from '../../../apps/api/src/modules/platform/legacy-importer/application/panel-mapping';
import type { LegacyInventoryRead } from '../../../apps/api/src/modules/platform/legacy-importer/application/ports';
import { SYNTHETIC_PANEL_ACCOUNTS, SYNTHETIC_PANEL_CODES } from './synthetic-legacy';

/** The mapping file for the dataset, given the NEXA ids of RickPanel A and B. */
export function syntheticMappingFile(tenantId: string, panelA: string, panelB: string): string {
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
      productionPanels: [panelA, panelB],
    },
    null,
    2,
  );
}

function index(panelId: string, names: readonly string[]): LegacyInventoryRead {
  const usernames = new Map<string, string[]>();
  for (const name of names) {
    const key = name.toLowerCase();
    usernames.set(key, [...(usernames.get(key) ?? []), name].sort());
  }
  return {
    ok: true,
    complete: true,
    index: { panelId, usernames },
    accounts: names.length,
    states: { active: names.length },
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
