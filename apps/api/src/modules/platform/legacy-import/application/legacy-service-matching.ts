/**
 * Migration P5 — matching a legacy service row to a live RickPanel account
 * (`docs/rickpanel-inventory.md` §Matching). Pure; no I/O.
 *
 * The program's rule (§11, §19) and nothing else:
 *
 * - **Panel known** — the legacy `code_panel` is in the operator's EXPLICIT
 *   `code_panel → NEXA panel UUID` map. Match `lower(username)` on that panel's
 *   inventory: present → eligible; absent → `manual_review / PROVIDER_MISSING`.
 * - **No panel** — the legacy row names no panel (`code_panel` empty or NULL). Owner rule
 *   2026-10-18 (replacing owner decision 8 of 2026-10-07): the exact lowercase username is
 *   searched across every CONNECTED production panel, exactly as a declared-missing code is:
 *   exactly one holder → eligible on that panel; none → `NO_PANEL` (the account is on no
 *   connected panel: ended, archived exactly as an unmapped code is — the same map row
 *   `PANEL_UNMAPPED`, no service, since an ended service names a panel and none is guessed);
 *   more than one → `AMBIGUOUS_PANEL` (stays in review). An operator's explicit approval naming a panel
 *   (`matchOnPanel`) still decides on that panel alone.
 * - **Panel declared missing** — a code the operator listed in the map's `missingPanels`:
 *   the operator explicitly asked for its rows to be searched across every configured
 *   production RickPanel: exactly one → eligible on that panel; none → `PROVIDER_MISSING`;
 *   more than one → `AMBIGUOUS_PANEL`. (Whether this explicit declaration should also become
 *   review-only is the owner's question, `OQ-LSR-02`.)
 * - **Test panel** — skipped, checked FIRST: whatever the row holds, it is not imported.
 * - Anything else (a `code_panel` that is neither mapped, nor test, nor declared missing)
 *   is `PANEL_UNMAPPED`: an operator forgot a mapping, and searching every panel for it
 *   would turn that omission into a guess.
 *
 * A name that folds to several spellings on one panel (`Alice`, `alice`) is
 * `USERNAME_CASE_COLLISION`, never eligible. An eligible match carries the panel's exact
 * spelling, which is what an adoption must store.
 *
 * Deliberately absent: the legacy inbound id, any fuzzy or prefix match, any
 * case-insensitive comparison other than the one lowercase fold, and any decision from an
 * INCOMPLETE inventory — zero matches in a partial walk is not "missing". A per-name
 * resolution (`PanelInventoryIndex.covered`) decides only the names it covers; any other
 * name on that panel is as undecidable as on a panel with no inventory at all.
 *
 * Reason codes are spelled as `LEGACY_IMPORT_REASON_CODES` (Migration P4) spells them;
 * `USERNAME_CASE_COLLISION` is added to that contract set when P4 is restacked.
 */

export type LegacyMatchReason =
  | 'PROVIDER_MISSING'
  | 'AMBIGUOUS_PANEL'
  | 'PANEL_UNMAPPED'
  /**
   * One panel holds two or more accounts whose names fold to the legacy row's lowercase
   * name (`Alice` and `alice`). Which one the legacy row meant is a guess, so no row is
   * eligible on it.
   */
  | 'USERNAME_CASE_COLLISION';

/**
 * One configured RickPanel's COMPLETE inventory: lowercase name → every exact provider
 * spelling that folds to it, sorted. One spelling is the normal case; more than one is a
 * case collision.
 */
export interface PanelInventoryIndex {
  readonly panelId: string;
  readonly usernames: ReadonlyMap<string, readonly string[]>;
  /**
   * Absent: the index is one COMPLETE inventory, so a name it does not hold is absent from
   * the panel. Present: a per-name resolution of a panel that was not one complete snapshot —
   * only these names were decided (held in `usernames`, or proven absent); any OTHER name is
   * undecidable on this panel, never "missing".
   */
  readonly covered?: ReadonlySet<string>;
}

/** Whether `index` decided `username` (always, for a complete inventory). */
export function indexCovers(index: PanelInventoryIndex, username: string): boolean {
  return index.covered === undefined || index.covered.has(username);
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
  | {
      readonly kind: 'ELIGIBLE';
      readonly panelId: string;
      /** The lowercase matching key. */
      readonly username: string;
      /** The panel's exact spelling — what an adoption stores and addresses (C3). */
      readonly providerUsername: string;
    }
  | {
      readonly kind: 'MANUAL_REVIEW';
      readonly reason: LegacyMatchReason;
      /** How many configured panels hold the name (0 or ≥2); never which accounts. */
      readonly candidatePanels: number;
    }
  | { readonly kind: 'SKIPPED'; readonly reason: 'TEST_PANEL' }
  /**
   * Owner rule 2026-10-18: the row names no panel and NO connected panel holds its account
   * (every complete inventory searched). Ended and archived exactly as an unmapped code is:
   * `PANEL_UNMAPPED` on the map row (no mapped panel exists for it), no service.
   */
  | { readonly kind: 'NO_PANEL' }
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

function onePanel(
  panelId: string,
  username: string,
  spellings: readonly string[] | undefined,
): LegacyServiceMatch {
  if (spellings === undefined || spellings.length === 0) {
    return { kind: 'MANUAL_REVIEW', reason: 'PROVIDER_MISSING', candidatePanels: 0 };
  }
  if (spellings.length > 1) {
    return { kind: 'MANUAL_REVIEW', reason: 'USERNAME_CASE_COLLISION', candidatePanels: 1 };
  }
  return { kind: 'ELIGIBLE', panelId, username, providerUsername: spellings[0] as string };
}

function onMappedPanel(
  panelId: string,
  username: string,
  inventories: ReadonlyMap<string, PanelInventoryIndex>,
): LegacyServiceMatch {
  const inventory = inventories.get(panelId);
  if (inventory === undefined || !indexCovers(inventory, username)) {
    return { kind: 'UNDECIDABLE', reason: 'INVENTORY_INCOMPLETE' };
  }
  return onePanel(panelId, username, inventory.usernames.get(username));
}

/**
 * Mirza PR5 — the match on ONE panel an operator named in an explicit ADOPT approval, with
 * exactly the rules a mapped code gets: a test code is still skipped, the username must be
 * one the matcher compares, and the panel's COMPLETE inventory must hold exactly one
 * spelling. The caller has already refused a panel the map does not map, and a code the map
 * maps to a different panel (an explicit mapping is never overridden).
 */
export function matchOnPanel(
  row: LegacyServiceRow,
  panelId: string,
  policy: Pick<LegacyPanelPolicy, 'testPanels'>,
  inventories: ReadonlyMap<string, PanelInventoryIndex>,
): LegacyServiceMatch {
  if (row.codePanel !== null && policy.testPanels.has(row.codePanel)) {
    return { kind: 'SKIPPED', reason: 'TEST_PANEL' };
  }
  const username = canonicalLegacyUsername(row.username);
  if (username === null) return { kind: 'INVALID', reason: 'INVALID_SOURCE_ROW' };
  return onMappedPanel(panelId, username, inventories);
}

export function matchLegacyService(
  row: LegacyServiceRow,
  policy: LegacyPanelPolicy,
  inventories: ReadonlyMap<string, PanelInventoryIndex>,
): LegacyServiceMatch {
  // A test panel's row is skipped whatever it contains: it is not imported, so whether
  // its username is comparable is not a question worth a manual-review entry.
  if (row.codePanel !== null && policy.testPanels.has(row.codePanel)) {
    return { kind: 'SKIPPED', reason: 'TEST_PANEL' };
  }

  const username = canonicalLegacyUsername(row.username);
  if (username === null) return { kind: 'INVALID', reason: 'INVALID_SOURCE_ROW' };

  if (row.codePanel !== null && policy.knownPanels.has(row.codePanel)) {
    return onMappedPanel(policy.knownPanels.get(row.codePanel) as string, username, inventories);
  }

  // Owner rule 2026-10-18: a row naming no panel is searched across every connected panel,
  // exactly as a declared-missing code is — one holder adopts, none is ended, several stay in
  // review.
  if (row.codePanel === null) {
    return searchProductionPanels(username, policy, inventories, { kind: 'NO_PANEL' });
  }

  if (!policy.missingPanels.has(row.codePanel)) {
    return { kind: 'MANUAL_REVIEW', reason: 'PANEL_UNMAPPED', candidatePanels: 0 };
  }

  return searchProductionPanels(username, policy, inventories, {
    kind: 'MANUAL_REVIEW',
    reason: 'PROVIDER_MISSING',
    candidatePanels: 0,
  });
}

/**
 * The exact lowercase username across every configured (connected) production panel: what a
 * declared-missing code and a row naming no panel are both decided by.
 */
function searchProductionPanels(
  username: string,
  policy: LegacyPanelPolicy,
  inventories: ReadonlyMap<string, PanelInventoryIndex>,
  /** What "no connected panel holds it" is for this row. */
  none: LegacyServiceMatch,
): LegacyServiceMatch {
  // The AVAILABLE inventories are scanned first: two known holders are ambiguous whatever
  // a panel without a complete inventory might add. Only while zero or one holder is
  // known can an unavailable inventory change the answer, so only then is it UNDECIDABLE.
  const holders: { readonly panelId: string; readonly spellings: readonly string[] }[] = [];
  let unavailable = 0;
  for (const panelId of new Set(policy.productionPanelIds)) {
    const inventory = inventories.get(panelId);
    if (inventory === undefined || !indexCovers(inventory, username)) {
      unavailable += 1;
      continue;
    }
    const spellings = inventory.usernames.get(username);
    if (spellings !== undefined && spellings.length > 0) holders.push({ panelId, spellings });
  }
  if (holders.length >= 2) {
    return { kind: 'MANUAL_REVIEW', reason: 'AMBIGUOUS_PANEL', candidatePanels: holders.length };
  }
  if (unavailable > 0) return { kind: 'UNDECIDABLE', reason: 'INVENTORY_INCOMPLETE' };
  const only = holders[0];
  if (only === undefined) return none;
  return onePanel(only.panelId, username, only.spellings);
}
