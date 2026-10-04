import { z } from 'zod';
import type { LegacyPanelPolicy } from '../../legacy-import/application/legacy-service-matching.js';
import { sha256Hex } from './source-snapshot.js';

/**
 * Item 6 — the final panel mapping, as an explicit input file
 * (`docs/legacy-migration/importer.md` §Panel mapping).
 *
 * The program's rule: legacy `code_panel` → NEXA RickPanel panel UUID, explicitly, and
 * nothing else. So the file format has no field a guess could hide in:
 *
 * - no inbound id (the matcher never reads one, and the strict schema refuses the key);
 * - no pattern, prefix or "default" panel;
 * - a code is in AT MOST one of `panels`, `testPanels`, `missingPanels`;
 * - every panel it names is checked against the tenant's panels before any run — it
 *   exists, in THIS tenant, is a RickPanel, is ACTIVE and not archived — and every mapped
 *   panel is also a production panel (the set a missing `code_panel` is searched across).
 *
 * The fingerprint is over the CANONICAL content (sorted), so reformatting the file does not
 * change it and any change of meaning does. It is recorded with the run, and a resume
 * under a different mapping is refused.
 */

export const PANEL_MAPPING_FORMAT = 'nexa-legacy-panel-map/v1';

const codePanel = z
  .string()
  .min(1)
  .max(200)
  .refine((v) => v === v.trim() && !/\p{Cc}/u.test(v), {
    message:
      'a code_panel is written exactly as the legacy row holds it, trimmed, no control characters',
  });
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u, {
  message: 'a panel id is a lowercase uuid',
});

const mappingSchema = z
  .object({
    format: z.literal(PANEL_MAPPING_FORMAT),
    tenantId: uuid,
    panels: z.array(z.object({ codePanel, panelId: uuid }).strict()),
    testPanels: z.array(codePanel),
    missingPanels: z.array(codePanel),
    productionPanels: z.array(uuid).min(1),
    /**
     * P6 ask 2: the owner's explicit map from a legacy `code_product` to the NEXA product
     * an adopted service of that product renews as. Optional (absent = no named product is
     * adoptable); a code not listed is PRODUCT_MAPPING_UNRESOLVED, never a guess.
     */
    products: z
      .array(
        z
          .object({
            codeProduct: z
              .string()
              .min(1)
              .max(200)
              .refine((v) => v === v.trim() && !/\p{Cc}/u.test(v), {
                message: 'a code_product is written exactly as the legacy row holds it',
              }),
            productId: uuid,
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export type PanelMappingFile = z.infer<typeof mappingSchema>;

export interface PanelMapping {
  readonly file: PanelMappingFile;
  readonly fingerprint: string;
  readonly policy: LegacyPanelPolicy;
  /** Legacy `code_product` → NEXA product id, exactly as the owner listed it. */
  readonly products: ReadonlyMap<string, string>;
}

export class PanelMappingRefused extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`The panel mapping is refused:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
}

/** The canonical content the fingerprint is taken over. */
export function canonicalPanelMapping(file: PanelMappingFile): string {
  const sorted = (xs: readonly string[]) => [...xs].sort();
  return JSON.stringify({
    format: file.format,
    tenantId: file.tenantId,
    panels: [...file.panels]
      .map((p) => [p.codePanel, p.panelId])
      .sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1)),
    testPanels: sorted(file.testPanels),
    missingPanels: sorted(file.missingPanels),
    productionPanels: sorted(file.productionPanels),
    products: [...file.products]
      .map((p) => [p.codeProduct, p.productId])
      .sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1)),
  });
}

/** Parses and checks the file's own consistency. The tenant check comes after (`validate…`). */
export function parsePanelMapping(text: string, tenantId: string): PanelMapping {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new PanelMappingRefused(['the file is not JSON']);
  }
  const parsed = mappingSchema.safeParse(json);
  if (!parsed.success) {
    throw new PanelMappingRefused(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const file = parsed.data;
  const problems: string[] = [];
  if (file.tenantId !== tenantId) problems.push('tenantId is not the --tenant this run names');

  const seen = new Map<string, string>();
  const claim = (code: string, list: string) => {
    const prior = seen.get(code);
    if (prior !== undefined) {
      problems.push(
        prior === list
          ? `code_panel ${JSON.stringify(code)} appears twice in ${list}`
          : `code_panel ${JSON.stringify(code)} is in both ${prior} and ${list}`,
      );
    } else {
      seen.set(code, list);
    }
  };
  for (const p of file.panels) claim(p.codePanel, 'panels');
  for (const c of file.testPanels) claim(c, 'testPanels');
  for (const c of file.missingPanels) claim(c, 'missingPanels');

  const production = new Set(file.productionPanels);
  if (production.size !== file.productionPanels.length) {
    problems.push('productionPanels names a panel twice');
  }
  for (const p of file.panels) {
    if (!production.has(p.panelId)) {
      problems.push(
        `code_panel ${JSON.stringify(p.codePanel)} maps to a panel that is not in productionPanels`,
      );
    }
  }
  const productCodes = new Set<string>();
  for (const p of file.products) {
    if (productCodes.has(p.codeProduct)) {
      problems.push(`code_product ${JSON.stringify(p.codeProduct)} appears twice in products`);
    }
    productCodes.add(p.codeProduct);
  }
  if (problems.length > 0) throw new PanelMappingRefused(problems);

  return {
    file,
    fingerprint: sha256Hex(canonicalPanelMapping(file)),
    policy: {
      knownPanels: new Map(file.panels.map((p) => [p.codePanel, p.panelId])),
      testPanels: new Set(file.testPanels),
      missingPanels: new Set(file.missingPanels),
      productionPanelIds: [...production].sort(),
    },
    products: new Map(file.products.map((p) => [p.codeProduct, p.productId])),
  };
}

/** What the tenant says about one panel the file names. */
export interface PanelFacts {
  readonly id: string;
  readonly tenantId: string;
  readonly providerType: string;
  readonly status: string;
  readonly archived: boolean;
}

/**
 * Every panel the file names must be one this run may READ for the migration: in the
 * tenant, a RickPanel, ACTIVE, not archived. `lookup` returns only the tenant's own
 * panels, so a panel of another tenant is indistinguishable from a missing one — both
 * are refused with the same sentence.
 */
export function validatePanelMappingAgainstTenant(
  mapping: PanelMapping,
  tenantPanels: readonly PanelFacts[],
): void {
  const byId = new Map(tenantPanels.map((p) => [p.id, p]));
  const problems: string[] = [];
  for (const panelId of mapping.policy.productionPanelIds) {
    const panel = byId.get(panelId);
    if (panel === undefined || panel.tenantId !== mapping.file.tenantId) {
      problems.push(`panel ${panelId} does not exist in this tenant`);
      continue;
    }
    if (panel.providerType !== 'rickpanel') {
      problems.push(`panel ${panelId} is not a RickPanel (${panel.providerType})`);
    }
    if (panel.status !== 'ACTIVE' || panel.archived) {
      problems.push(
        `panel ${panelId} is not ACTIVE (${panel.archived ? 'ARCHIVED' : panel.status})`,
      );
    }
  }
  if (problems.length > 0) throw new PanelMappingRefused(problems);
}

/**
 * The legacy `code_panel` values among live real invoices that the file does not mention,
 * with their counts. Panel codes are not credentials (`sql-evidence.md` Q1b) and may be
 * reported; each becomes `PANEL_UNMAPPED` until an operator maps, tests or declares it.
 */
export function unmappedCodePanels(
  codes: Iterable<string | null>,
  mapping: PanelMapping,
): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const raw of codes) {
    const code = raw?.trim() ?? '';
    if (code === '') continue;
    const { knownPanels, testPanels, missingPanels } = mapping.policy;
    if (knownPanels.has(code) || testPanels.has(code) || missingPanels.has(code)) continue;
    out.set(code, (out.get(code) ?? 0) + 1);
  }
  return out;
}

/**
 * Every product the file maps a legacy `code_product` to must be a product of THIS tenant.
 * Whether it is adoptable (live, priced, renewable) is P6's question, decided per service.
 */
export function validateProductMappingAgainstTenant(
  mapping: PanelMapping,
  tenantProductIds: ReadonlySet<string>,
): void {
  const problems: string[] = [];
  for (const [code, productId] of mapping.products) {
    if (!tenantProductIds.has(productId)) {
      problems.push(
        `code_product ${JSON.stringify(code)} maps to product ${productId}, which does not exist in this tenant`,
      );
    }
  }
  if (problems.length > 0) throw new PanelMappingRefused(problems);
}
