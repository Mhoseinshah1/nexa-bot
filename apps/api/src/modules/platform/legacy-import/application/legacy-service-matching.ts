/**
 * Migration P5 — matching a legacy service row to a live RickPanel account
 * (`docs/rickpanel-inventory.md` §Matching). Pure; no I/O.
 *
 * The program's rule (§11, §19) and nothing else:
 *
 * - **Panel known** — the legacy `code_panel` is in the operator's EXPLICIT
 *   `code_panel → NEXA panel UUID` map. Match `lower(username)` on that panel's
 *   inventory: present → eligible; absent → `manual_review / PROVIDER_MISSING`.
 * - **Panel missing** — the legacy row names no panel, or one the operator declared
 *   missing. Search the exact lowercase username across every configured production
 *   RickPanel: exactly one → eligible on that panel; none → `PROVIDER_MISSING`; more than
 *   one → `AMBIGUOUS_PANEL`.
 * - **Test panel** — skipped.
 * - Anything else (a `code_panel` that is neither mapped, nor test, nor declared missing)
 *   is `PANEL_UNMAPPED`: an operator forgot a mapping, and searching every panel for it
 *   would turn that omission into a guess.
 *
 * Deliberately absent: the legacy inbound id, any fuzzy or prefix match, any
 * case-insensitive comparison other than the one lowercase fold, and any decision from an
 * INCOMPLETE inventory — zero matches in a partial walk is not "missing".
 *
 * Reason codes are spelled as `LEGACY_IMPORT_REASON_CODES` (Migration P4) spells them.
 */

export type LegacyMatchReason = 'PROVIDER_MISSING' | 'AMBIGUOUS_PANEL' | 'PANEL_UNMAPPED';

/** One configured RickPanel's COMPLETE inventory, reduced to its canonical names. */
export interface PanelInventoryIndex {
  readonly panelId: string;
  readonly usernames: ReadonlySet<string>;
}

export interface LegacyServiceRow {
  /** Null when the legacy row names no panel. */
  readonly codePanel: string | null;
  readonly username: string;
}

export interface LegacyPanelPolicy {
  /** The explicit operator map: legacy `code_panel` → NEXA RickPanel UUID. */
  readonly knownPanels: ReadonlyMap<string, string>;
  /** Legacy test panels: their rows are skipped. */
  readonly testPanels: ReadonlySet<string>;
  /** Legacy `code_panel` values the operator declared missing (searched across panels). */
  readonly missingPanels: ReadonlySet<string>;
  /** Every configured production RickPanel. Searched for a missing panel. */
  readonly productionPanelIds: readonly string[];
}

export type LegacyServiceMatch =
  | { readonly kind: 'ELIGIBLE'; readonly panelId: string; readonly username: string }
  | {
      readonly kind: 'MANUAL_REVIEW';
      readonly reason: LegacyMatchReason;
      /** How many configured panels hold the name (0 or ≥2); never which accounts. */
      readonly candidatePanels: number;
    }
  | { readonly kind: 'SKIPPED'; readonly reason: 'TEST_PANEL' }
  /** A legacy username this matcher will not compare (empty, non-ASCII, too long). */
  | { readonly kind: 'INVALID'; readonly reason: 'INVALID_SOURCE_ROW' }
  /**
   * A panel this decision depends on has no complete inventory. Not a manual-review
   * outcome: re-run the inventory and decide again.
   */
  | { readonly kind: 'UNDECIDABLE'; readonly reason: 'INVENTORY_INCOMPLETE' };

/** Same rule as the inventory's `canonicalUsername`: printable ASCII, lowercased. */
export function canonicalLegacyUsername(raw: string): string | null {
  if (raw.length === 0 || raw.length > 128) return null;
  if (!/^[\x21-\x7e]+$/.test(raw)) return null;
  return raw.toLowerCase();
}

export function matchLegacyService(
  row: LegacyServiceRow,
  policy: LegacyPanelPolicy,
  inventories: ReadonlyMap<string, PanelInventoryIndex>,
): LegacyServiceMatch {
  const username = canonicalLegacyUsername(row.username);
  if (username === null) return { kind: 'INVALID', reason: 'INVALID_SOURCE_ROW' };

  if (row.codePanel !== null && policy.testPanels.has(row.codePanel)) {
    return { kind: 'SKIPPED', reason: 'TEST_PANEL' };
  }

  if (row.codePanel !== null && policy.knownPanels.has(row.codePanel)) {
    const panelId = policy.knownPanels.get(row.codePanel) as string;
    const inventory = inventories.get(panelId);
    if (inventory === undefined) return { kind: 'UNDECIDABLE', reason: 'INVENTORY_INCOMPLETE' };
    return inventory.usernames.has(username)
      ? { kind: 'ELIGIBLE', panelId, username }
      : { kind: 'MANUAL_REVIEW', reason: 'PROVIDER_MISSING', candidatePanels: 0 };
  }

  if (row.codePanel !== null && !policy.missingPanels.has(row.codePanel)) {
    return { kind: 'MANUAL_REVIEW', reason: 'PANEL_UNMAPPED', candidatePanels: 0 };
  }

  // Missing panel: exact lowercase username across every configured production panel.
  const holders: string[] = [];
  for (const panelId of new Set(policy.productionPanelIds)) {
    const inventory = inventories.get(panelId);
    if (inventory === undefined) return { kind: 'UNDECIDABLE', reason: 'INVENTORY_INCOMPLETE' };
    if (inventory.usernames.has(username)) holders.push(panelId);
  }
  if (holders.length === 1) {
    return { kind: 'ELIGIBLE', panelId: holders[0] as string, username };
  }
  return holders.length === 0
    ? { kind: 'MANUAL_REVIEW', reason: 'PROVIDER_MISSING', candidatePanels: 0 }
    : { kind: 'MANUAL_REVIEW', reason: 'AMBIGUOUS_PANEL', candidatePanels: holders.length };
}
