import type { LegacyNxpkgErrorCode } from '@nexa/contracts';
import {
  PANEL_MAPPING_FORMAT,
  PanelMappingRefused,
  parsePanelMapping,
  validatePanelMappingAgainstTenant,
  type PanelFacts,
  type PanelMapping,
} from './panel-mapping.js';

/**
 * Mirza `.nxpkg` importer — the panel map, from the package's operator-selected targets and
 * the admin's binding (`docs/legacy-migration/nxpkg-importer.md` §1, principle 4).
 *
 * The converter records, per legacy `code_panel`, the NEXA target the operator chose
 * (`records/panel_target_mapping.jsonl`, `m2n.legacy_panel_target.v1`): only ever `rickpanel`,
 * either an existing NEXA panel (`CONNECT_EXISTING_NEXA_PANEL` with its `nexa_panel_id`) or one
 * to create in NEXA first (`CREATE_IN_NEXA_THEN_CONNECT`). In NEXA the admin binds each such
 * code to a panel of the tenant. This module turns the two into the importer's ONE input format,
 * `nexa-legacy-panel-map/v1`, and fails closed (`PANEL_TARGET_MISMATCH`) on anything that is not
 * exactly that:
 *
 * - a code with a target must be bound, to an existing ACTIVE, non-archived `rickpanel` panel of
 *   THIS tenant — a Marzban or Sanaei panel, a disabled or archived one, another tenant's or an
 *   unknown id is refused; a `CONNECT_EXISTING` target binds only to its own `nexa_panel_id`;
 * - a code WITHOUT a target (`OPERATOR_MUST_MAP`) is declared `unresolvedPanels` with
 *   `OWNER_DECIDES_LATER`: its invoices stay `PANEL_UNMAPPED` review, never adopted. Binding one
 *   is refused (the package never said where it goes);
 * - the converter's `(no code_panel)` bucket is never in the map: NEXA decides an empty code
 *   `NO_PANEL` itself (owner decision 8). A target on it is refused;
 * - a binding for a code the package does not list is refused; a code listed twice is refused;
 * - no test panels: the package carries no evidence that a code is a test panel, and the map
 *   never guesses one.
 *
 * Nothing here creates, changes or connects a panel. The result is then checked by the
 * importer's own `parsePanelMapping` and `validatePanelMappingAgainstTenant`, unchanged.
 */

export const NXPKG_PANEL_TARGET_SCHEMA = 'm2n.legacy_panel_target.v1';
export const NXPKG_NO_CODE_PANEL = '(no code_panel)';
const CONNECT_EXISTING = 'CONNECT_EXISTING_NEXA_PANEL';
const CREATE_THEN_CONNECT = 'CREATE_IN_NEXA_THEN_CONNECT';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** A refusal of the package import, with its contract code and fixed problem sentences. */
export class NxpkgImportRefused extends Error {
  constructor(
    readonly code: LegacyNxpkgErrorCode,
    readonly problems: readonly string[],
    /** `FRESH_TARGET_NOT_EMPTY`: the count per table, for the operator. Counts only. */
    readonly counts: Readonly<Record<string, number>> | null = null,
  ) {
    super(`${code}:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
}

export interface NxpkgPanelBindingInput {
  readonly tenantId: string;
  /** The records of `records/panel_target_mapping.jsonl`, as read. */
  readonly targets: readonly Record<string, unknown>[];
  /** The admin's choice: legacy `code_panel` → NEXA panel id. */
  readonly bindings: Readonly<Record<string, string>>;
  /** The tenant's panels (every one; the binding may name any). */
  readonly tenantPanels: readonly PanelFacts[];
  /** The owner's `products` section, passed through to the map unchanged. */
  readonly products?: readonly { readonly codeProduct: string; readonly productId: string }[];
}

export interface NxpkgPanelBinding {
  /** The `nexa-legacy-panel-map/v1` file, as the importer and the CLI read it. */
  readonly text: string;
  readonly mapping: PanelMapping;
  /** Codes left unresolved (no target in the package), sorted. */
  readonly unresolved: readonly string[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function buildPanelMappingFromTargets(input: NxpkgPanelBindingInput): NxpkgPanelBinding {
  const problems: string[] = [];
  const panels = new Map(input.tenantPanels.map((p) => [p.id, p]));
  const listed = new Set<string>();
  const mapped: { codePanel: string; panelId: string }[] = [];
  const unresolved: string[] = [];

  for (const record of input.targets) {
    const code = record['code_panel'];
    if (
      record['record_type'] !== 'legacy_panel_target' ||
      record['schema'] !== NXPKG_PANEL_TARGET_SCHEMA ||
      typeof code !== 'string' ||
      code === ''
    ) {
      problems.push('a panel target record is not a m2n.legacy_panel_target.v1 record');
      continue;
    }
    if (listed.has(code)) {
      problems.push(`code_panel ${JSON.stringify(code)} has two target records`);
      continue;
    }
    listed.add(code);
    for (const flag of [
      'provision',
      'applies_to_live_state',
      'services_reprovisioned',
      'credentials_in_package',
    ]) {
      if (Object.hasOwn(record, flag) && record[flag] !== false) {
        problems.push(`code_panel ${JSON.stringify(code)}: ${flag} is not false`);
      }
    }
    const target = record['target'];
    const bound = Object.hasOwn(input.bindings, code) ? input.bindings[code] : undefined;

    if (code === NXPKG_NO_CODE_PANEL) {
      if (target !== null)
        problems.push('the empty-code bucket carries a target; it is never mapped');
      if (bound !== undefined) problems.push('the empty-code bucket cannot be bound to a panel');
      continue;
    }
    if (target === null) {
      if (bound !== undefined) {
        problems.push(
          `code_panel ${JSON.stringify(code)} has no RickPanel target in the package and cannot be bound`,
        );
        continue;
      }
      unresolved.push(code);
      continue;
    }
    if (
      !isObject(target) ||
      target['provider_type'] !== 'rickpanel' ||
      target['provider_display_name'] !== 'RickPanel'
    ) {
      problems.push(
        `code_panel ${JSON.stringify(code)}: the package target is not RickPanel (rickpanel)`,
      );
      continue;
    }
    const kind = target['binding'];
    const declared = target['nexa_panel_id'];
    if (!(
      (kind === CONNECT_EXISTING && typeof declared === 'string' && UUID.test(declared)) ||
      (kind === CREATE_THEN_CONNECT && declared === null)
    )) {
      problems.push(`code_panel ${JSON.stringify(code)}: the package target binding is malformed`);
      continue;
    }
    const entry = record['nexa_panel_map_entry'];
    if (
      kind === CONNECT_EXISTING
        ? !(isObject(entry) && entry['codePanel'] === code && entry['panelId'] === declared)
        : entry !== null
    ) {
      problems.push(
        `code_panel ${JSON.stringify(code)}: the package map entry disagrees with its target`,
      );
      continue;
    }
    if (bound === undefined) {
      problems.push(`code_panel ${JSON.stringify(code)} has a RickPanel target and is not bound`);
      continue;
    }
    if (!UUID.test(bound)) {
      problems.push(
        `code_panel ${JSON.stringify(code)} is bound to something that is not a panel id`,
      );
      continue;
    }
    if (kind === CONNECT_EXISTING && bound !== declared) {
      problems.push(
        `code_panel ${JSON.stringify(code)} is bound to another panel than the package's target`,
      );
      continue;
    }
    const panel = panels.get(bound);
    if (panel === undefined || panel.tenantId !== input.tenantId) {
      problems.push(
        `code_panel ${JSON.stringify(code)} is bound to a panel this tenant does not have`,
      );
      continue;
    }
    if (panel.providerType !== 'rickpanel') {
      problems.push(
        `code_panel ${JSON.stringify(code)} is bound to a ${panel.providerType} panel, not a RickPanel`,
      );
      continue;
    }
    if (panel.status !== 'ACTIVE' || panel.archived) {
      problems.push(`code_panel ${JSON.stringify(code)} is bound to a panel that is not ACTIVE`);
      continue;
    }
    mapped.push({ codePanel: code, panelId: bound });
  }
  for (const code of Object.keys(input.bindings)) {
    if (!listed.has(code)) {
      problems.push(
        `a binding names code_panel ${JSON.stringify(code)}, which the package does not list`,
      );
    }
  }
  if (mapped.length === 0 && problems.length === 0) {
    problems.push(
      'no code_panel is bound to a RickPanel: there is nothing to import services onto',
    );
  }
  if (problems.length > 0) throw new NxpkgImportRefused('PANEL_TARGET_MISMATCH', problems);

  const byCode = (a: { codePanel: string }, b: { codePanel: string }) =>
    a.codePanel < b.codePanel ? -1 : a.codePanel > b.codePanel ? 1 : 0;
  const file = {
    format: PANEL_MAPPING_FORMAT,
    tenantId: input.tenantId,
    panels: [...mapped].sort(byCode),
    testPanels: [] as string[],
    missingPanels: [] as string[],
    ...(unresolved.length === 0
      ? {}
      : {
          unresolvedPanels: [...unresolved]
            .sort()
            .map((codePanel) => ({ codePanel, reason: 'OWNER_DECIDES_LATER' as const })),
        }),
    productionPanels: [...new Set(mapped.map((m) => m.panelId))].sort(),
    products: [...(input.products ?? [])],
  };
  const text = `${JSON.stringify(file, null, 2)}\n`;
  let mapping: PanelMapping;
  try {
    mapping = parsePanelMapping(text, input.tenantId);
    validatePanelMappingAgainstTenant(mapping, input.tenantPanels);
  } catch (error) {
    if (error instanceof PanelMappingRefused) {
      throw new NxpkgImportRefused('PANEL_TARGET_MISMATCH', error.problems);
    }
    throw error;
  }
  return { text, mapping, unresolved: [...unresolved].sort() };
}

/**
 * The importer's `.nxpkg` path (`runMode`): a panel map GIVEN for a package (the operator's
 * `--panel-map`, or the migration worker's) is accepted only if it is exactly the map the
 * package's targets make with the same bindings — `buildPanelMappingFromTargets` over the
 * map's own `panels` (and its `products`, passed through), compared by fingerprint. So the
 * same rules hold whoever wrote the file: every targeted code bound to an ACTIVE RickPanel of
 * this tenant (a CONNECT_EXISTING target to its own id), no code bound without a target, no
 * test or missing panels, the untargeted codes declared `OWNER_DECIDES_LATER` and nothing else.
 * `PANEL_TARGET_MISMATCH` otherwise.
 */
export function validatePanelMappingAgainstTargets(input: {
  readonly tenantId: string;
  readonly targets: readonly Record<string, unknown>[];
  readonly mapping: PanelMapping;
  /** The tenant's panels the map names (or all of them). */
  readonly tenantPanels: readonly PanelFacts[];
}): NxpkgPanelBinding {
  const bindings: Record<string, string> = {};
  for (const { codePanel, panelId } of input.mapping.file.panels) {
    if (Object.hasOwn(bindings, codePanel)) {
      throw new NxpkgImportRefused('PANEL_TARGET_MISMATCH', [
        `the panel map lists code_panel ${JSON.stringify(codePanel)} twice`,
      ]);
    }
    bindings[codePanel] = panelId;
  }
  const built = buildPanelMappingFromTargets({
    tenantId: input.tenantId,
    targets: input.targets,
    bindings,
    tenantPanels: input.tenantPanels,
    products: input.mapping.file.products,
  });
  if (built.mapping.fingerprint !== input.mapping.fingerprint) {
    throw new NxpkgImportRefused('PANEL_TARGET_MISMATCH', [
      'the panel map is not the one the package targets make with its bindings (a test or ' +
        'missing panel, another production panel set, or an unresolved set other than the ' +
        "package's untargeted codes)",
    ]);
  }
  return built;
}
