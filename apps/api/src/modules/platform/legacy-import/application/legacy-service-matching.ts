/**
 * Migration P5 — matching a legacy service row to a live RickPanel account
 * (`docs/rickpanel-inventory.md` §Matching). Pure; no I/O.
 *
 * The program's rule (§11, §19) and nothing else:
 *
 * - **Panel known** — the legacy `code_panel` is in the operator's EXPLICIT
 *   `code_panel → NEXA panel UUID` map. Match `lower(username)` on that panel's
 *   inventory: present → eligible; absent → `manual_review / PROVIDER_MISSING`.
 * - **No panel** — the legacy row names no panel (`code_panel` empty or NULL). Owner
 *   decision 8 (2026-10-07, Mirza PR5): such a row is NEVER adopted automatically and NEVER
 *   searched for: `NO_PANEL`, whatever the inventories hold. Only an operator's explicit
 *   approval, naming a mapped panel, may adopt it (`matchOnPanel`, executed by an import run
 *   that re-runs every check). Before PR5 this row was searched across every production
 *   panel and adopted on a unique hit — a panel guessed from a username.
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
 * INCOMPLETE inventory — zero matches in a partial walk is not "missing".
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
   * Owner decision 8: the row names no panel. Never searched, never eligible; recorded for
   * review (`PANEL_UNMAPPED` on the map row: no mapped panel exists for it).
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
  if (inventory === undefined) return { kind: 'UNDECIDABLE', reason: 'INVENTORY_INCOMPLETE' };
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

  // Owner decision 8: no panel is never searched for — not even a unique hit is adopted.
  if (row.codePanel === null) return { kind: 'NO_PANEL' };

  if (!policy.missingPanels.has(row.codePanel)) {
    return { kind: 'MANUAL_REVIEW', reason: 'PANEL_UNMAPPED', candidatePanels: 0 };
  }

  // Declared missing: exact lowercase username across every configured production panel.
  // The AVAILABLE inventories are scanned first: two known holders are ambiguous whatever
  // a panel without a complete inventory might add. Only while zero or one holder is
  // known can an unavailable inventory change the answer, so only then is it UNDECIDABLE.
  const holders: { readonly panelId: string; readonly spellings: readonly string[] }[] = [];
  let unavailable = 0;
  for (const panelId of new Set(policy.productionPanelIds)) {
    const inventory = inventories.get(panelId);
    if (inventory === undefined) {
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
  if (only === undefined) {
    return { kind: 'MANUAL_REVIEW', reason: 'PROVIDER_MISSING', candidatePanels: 0 };
  }
  return onePanel(only.panelId, username, only.spellings);
}
