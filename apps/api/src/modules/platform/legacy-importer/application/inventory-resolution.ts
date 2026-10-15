/**
 * Per-name inventory resolution — pure, no I/O (`docs/rickpanel-inventory.md` §Per-name
 * resolution).
 *
 * The owner keeps Mirza selling while a dry run reads the live RickPanel, so a walk of a busy
 * panel is rarely one complete snapshot: accounts are created and deleted while the cursor
 * moves (`TOTAL_CHANGED`), and offset pagination can then skip rows. A row a walk received is
 * real; a row it did NOT receive proves nothing — unless the walk is GAP-FREE
 * (`RickpanelWalkCoverage`: overlapping pages, every boundary chained, ended at its own
 * total), in which case it returned every account that existed throughout it.
 *
 * Every needed name is decided on its own evidence, and only what that evidence proves:
 *
 * - **Collision** — two or more exact spellings that fold to the name were seen in ANY walk
 *   (or a lookup answers with one a walk did not see): `USERNAME_CASE_COLLISION`, manual review.
 * - **Present** — the backup's exact spelling was seen by EVERY walk, and at least one walk was
 *   gap-free and saw no other spelling: no case variant existed throughout that walk.
 * - **Lookup** — the panel is asked for the backup's exact spelling. Found → present, again
 *   only with a gap-free walk that saw no variant; 404 → absent, again only with a gap-free
 *   walk that saw no spelling of it (a 404 for one spelling says nothing about another).
 * - **Unresolved** — anything else: no gap-free walk, a failed or unanswered lookup, a name the
 *   backup spells two ways. It stays `INVENTORY_INCOMPLETE`, which a production-like approval
 *   refuses — never a guessed owner, never a guessed absence.
 *
 * Names the backup does not need — a manual account, a sale Mirza made after the backup — are
 * never decided, counted or looked up: they cannot become anyone's service.
 */

export interface ObservedAccount {
  /** The canonical (lowercase) name. */
  readonly username: string;
  /** The panel's exact spelling. */
  readonly providerUsername: string;
}

/** What the walks alone say about one needed name. */
export type WalkEvidence =
  | { readonly kind: 'PRESENT'; readonly spelling: string }
  | { readonly kind: 'COLLISION'; readonly spellings: readonly string[] }
  /** Nothing the walks or a lookup could show decides it. */
  | { readonly kind: 'UNDECIDABLE' }
  /**
   * Ask the panel for `ask`, the backup's exact spelling (`backupSpelling`; false only in a
   * hand-built evidence). `seen` is the one spelling any walk saw, if any; `seenByAll` whether
   * every walk saw it; `gapFree` whether a gap-free walk is there to exclude a variant.
   */
  | {
      readonly kind: 'LOOKUP';
      readonly ask: string;
      readonly seen: string | null;
      readonly backupSpelling: boolean;
      readonly seenByAll?: boolean;
      readonly gapFree?: boolean;
    };

/** What the panel answered an exact lookup. */
export type LookupAnswer =
  | { readonly kind: 'FOUND'; readonly spelling: string }
  | { readonly kind: 'NOT_FOUND' }
  /** A failure, a malformed answer, or no lookup left in the read's bound. */
  | { readonly kind: 'UNANSWERED' };

/** The final evidence for one needed name. */
export type NameResolution =
  | { readonly kind: 'PRESENT'; readonly spelling: string; readonly by: 'WALKS' | 'LOOKUP' }
  | { readonly kind: 'COLLISION'; readonly spellings: readonly string[] }
  | { readonly kind: 'ABSENT' }
  | { readonly kind: 'UNRESOLVED' };

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The walks' evidence for every needed name. `walks` are the accounts each walk received (a
 * complete walk's accounts, or an inconsistent walk's `observed`), at least two. `gapFree`:
 * at least one of them was a gap-free walk, and the walks agree on one stable order.
 */
export function classifyNeededNames(
  needed: ReadonlyMap<string, string | null>,
  walks: readonly (readonly ObservedAccount[])[],
  gapFree = false,
): Map<string, WalkEvidence> {
  if (walks.length < 2) throw new Error('a per-name resolution needs at least two walks');
  // name → spelling → how many walks saw it. Only needed names are held.
  const seen = new Map<string, Map<string, number>>();
  for (const accounts of walks) {
    const thisWalk = new Set<string>();
    for (const account of accounts) {
      if (!needed.has(account.username) || thisWalk.has(account.providerUsername)) continue;
      thisWalk.add(account.providerUsername);
      const spellings = seen.get(account.username) ?? new Map<string, number>();
      spellings.set(account.providerUsername, (spellings.get(account.providerUsername) ?? 0) + 1);
      seen.set(account.username, spellings);
    }
  }
  const out = new Map<string, WalkEvidence>();
  for (const [name, backup] of needed) {
    const spellings = seen.get(name);
    if (spellings !== undefined && spellings.size >= 2) {
      out.set(name, { kind: 'COLLISION', spellings: [...spellings.keys()].sort(byCodeUnit) });
      continue;
    }
    if (backup === null) {
      // Two backup spellings of one name: which account each invoice meant is a guess.
      out.set(name, { kind: 'UNDECIDABLE' });
      continue;
    }
    if (spellings === undefined || spellings.size === 0) {
      out.set(name, { kind: 'LOOKUP', ask: backup, seen: null, backupSpelling: true, gapFree });
      continue;
    }
    const [spelling, walksSeen] = [...spellings.entries()][0] as [string, number];
    const seenByAll = walksSeen === walks.length;
    if (seenByAll && spelling === backup && gapFree) {
      // Every walk saw exactly the account the backup names, and a gap-free walk saw no other
      // spelling of it: no case variant existed throughout that walk.
      out.set(name, { kind: 'PRESENT', spelling });
      continue;
    }
    out.set(name, {
      kind: 'LOOKUP',
      ask: backup,
      seen: spelling,
      backupSpelling: true,
      seenByAll,
      gapFree,
    });
  }
  return out;
}

/** The final evidence for a name the walks sent to a lookup. */
export function resolveLookup(
  evidence: Extract<WalkEvidence, { kind: 'LOOKUP' }>,
  answer: LookupAnswer,
): NameResolution {
  if (answer.kind === 'UNANSWERED') return { kind: 'UNRESOLVED' };
  // Without the backup's own spelling, an answer for a guessed one decides nothing.
  if (!evidence.backupSpelling) return { kind: 'UNRESOLVED' };
  if (answer.kind === 'FOUND') {
    if (evidence.seen !== null && answer.spelling !== evidence.seen) {
      // A walk saw one spelling and the panel answers with another that folds to the same
      // name: two accounts, or a rename mid-read — either way not one account to adopt.
      return { kind: 'COLLISION', spellings: [evidence.seen, answer.spelling].sort(byCodeUnit) };
    }
    // The account exists. It is THE account only if no variant can hide beside it.
    return evidence.gapFree === true
      ? { kind: 'PRESENT', spelling: answer.spelling, by: 'LOOKUP' }
      : { kind: 'UNRESOLVED' };
  }
  // A 404 proves only the spelling asked absent (RickPanel addresses a user by exact name);
  // without a gap-free walk another spelling may hide beside it, so it proves nothing.
  if (evidence.gapFree !== true) return { kind: 'UNRESOLVED' };
  // No walk saw any spelling, or a walk saw the backup's own and it is gone now.
  if (evidence.seen === null || evidence.seen === evidence.ask) return { kind: 'ABSENT' };
  // The backup's spelling is absent, and every walk saw one other spelling: the one account
  // there is, exactly as a complete read decides it. Seen by some walks only: undecided.
  return evidence.seenByAll === true
    ? { kind: 'PRESENT', spelling: evidence.seen, by: 'WALKS' }
    : { kind: 'UNRESOLVED' };
}

/** The resolution's counts, as the read reports them. */
export function resolutionCounts(resolved: ReadonlyMap<string, NameResolution>): {
  readonly presentByWalks: number;
  readonly presentByLookup: number;
  readonly absentByLookup: number;
  readonly collisions: number;
  readonly unresolved: number;
} {
  let presentByWalks = 0;
  let presentByLookup = 0;
  let absentByLookup = 0;
  let collisions = 0;
  let unresolved = 0;
  for (const r of resolved.values()) {
    if (r.kind === 'PRESENT') {
      if (r.by === 'WALKS') presentByWalks += 1;
      else presentByLookup += 1;
    } else if (r.kind === 'ABSENT') absentByLookup += 1;
    else if (r.kind === 'COLLISION') collisions += 1;
    else unresolved += 1;
  }
  return { presentByWalks, presentByLookup, absentByLookup, collisions, unresolved };
}

/** The invoice fields that decide whether, and where, the matcher will ask for a name. */
export interface NeedingInvoice {
  readonly idInvoice: string;
  readonly idUser: string | null;
  readonly username: string | null;
  readonly isTest: string | null;
  readonly codePanel: string | null;
}

/**
 * Per production panel, the canonical usernames the matcher may ask of it, each with the
 * backup's exact spelling (null when two of its invoices spell it differently): exactly the
 * questions `decideServiceCandidate` can put to an index, and no other (so a per-name
 * resolution decides — and looks up — only what the backup needs). A live, real (`is_test =
 * 0`) invoice of an IMPORTABLE owner (`importableUserIds`: the plan's own `importedUsers`; any
 * other owner is decided `CUSTOMER_NOT_IMPORTED` before an index is asked) with a comparable
 * username asks its mapped panel; a code the operator
 * declared missing asks every production panel; an operator's ADOPT approval asks the panel
 * it names. A test panel's row, an unmapped code and a row naming no panel ask nothing — the
 * matcher decides those without any inventory. A superset is harmless (an extra name is only
 * decided); a missing name would only leave its invoice undecidable, never wrongly decided.
 */
export function neededNamesByPanel(
  invoices: readonly NeedingInvoice[],
  importableUserIds: ReadonlySet<string>,
  policy: {
    readonly knownPanels: ReadonlyMap<string, string>;
    readonly testPanels: ReadonlySet<string>;
    readonly missingPanels: ReadonlySet<string>;
    readonly productionPanelIds: readonly string[];
  },
  operatorPanels: ReadonlyMap<string, string>,
  canonical: (raw: string) => string | null,
  isInvoiceKey: (key: string) => boolean,
): Map<string, Map<string, string | null>> {
  const out = new Map<string, Map<string, string | null>>();
  for (const panelId of policy.productionPanelIds) out.set(panelId, new Map());
  const add = (panelId: string, name: string, spelling: string) => {
    let names = out.get(panelId);
    if (names === undefined) {
      names = new Map();
      out.set(panelId, names);
    }
    const known = names.get(name);
    names.set(name, known === undefined || known === spelling ? spelling : null);
  };
  for (const invoice of invoices) {
    if (!isInvoiceKey(invoice.idInvoice)) continue;
    if (invoice.isTest?.trim() !== '0') continue;
    if (invoice.idUser === null || !importableUserIds.has(invoice.idUser)) continue;
    const spelling = invoice.username ?? '';
    const name = canonical(spelling);
    if (name === null) continue;
    const override = operatorPanels.get(invoice.idInvoice);
    if (override !== undefined) add(override, name, spelling);
    const raw = invoice.codePanel?.trim() ?? '';
    const code = raw === '' ? null : raw;
    if (code === null || policy.testPanels.has(code)) continue;
    const mapped = policy.knownPanels.get(code);
    if (mapped !== undefined) {
      add(mapped, name, spelling);
    } else if (policy.missingPanels.has(code)) {
      for (const panelId of policy.productionPanelIds) add(panelId, name, spelling);
    }
  }
  return out;
}
