/**
 * Per-name inventory resolution — pure, no I/O (`docs/rickpanel-inventory.md` §Per-name
 * resolution).
 *
 * The owner keeps Mirza selling while a dry run reads the live RickPanel, so a walk of a busy
 * panel is rarely one complete snapshot (`TOTAL_CHANGED`). A row a walk received is real; a row
 * it did NOT receive proves nothing — unless the walk is GAP-FREE (`RickpanelWalkCoverage`:
 * overlapping pages, every boundary chained, no insertion ahead of the cursor missed, ended at
 * its own total). A gap-free walk returned every account there was as of its end: it is a
 * snapshot of the panel, taken while the panel kept selling.
 *
 * Gap-free is not survival: a row read early may be deleted before the walk ends, and no check
 * inside one walk sees every such deletion. So every needed name is decided from the walks
 * alone, as of the end of a gap-free DECISION walk, and only with a later walk to confirm it:
 *
 * - **Collision** — two or more exact spellings that fold to the name seen in ANY walk:
 *   `USERNAME_CASE_COLLISION`, manual review.
 * - **Present** — the decision walk returned exactly one spelling of it, and a later walk
 *   returned the same row (same spelling, same `created_at`).
 * - **Absent** — the decision walk returned none and no later walk returned it; or it returned
 *   one that no later walk returned again, and a later gap-free walk returned no spelling of it
 *   (`PROVIDER_MISSING`, manual review — never a created account).
 * - **Unresolved** — anything else: no decision walk, a row neither confirmed nor shown gone,
 *   or a name the backup spells two ways. It stays `INVENTORY_INCOMPLETE`, which a production-like approval refuses — never a
 *   guessed owner, never a guessed absence.
 *
 * No exact lookup is sent: a lookup happens after a walk, which is exactly when a case variant
 * can appear unseen, and a 404 for one spelling says nothing about another. Names the backup
 * does not need — a manual account, a sale Mirza made after the backup — are never decided,
 * counted or indexed: they cannot become anyone's service.
 */

export interface ObservedAccount {
  /** The canonical (lowercase) name. */
  readonly username: string;
  /** The panel's exact spelling. */
  readonly providerUsername: string;
}

/** The decision for one needed name. */
export type NameResolution =
  | { readonly kind: 'PRESENT'; readonly spelling: string }
  | { readonly kind: 'COLLISION'; readonly spellings: readonly string[] }
  | { readonly kind: 'ABSENT' }
  | { readonly kind: 'UNRESOLVED' };

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** One walk, as the per-name resolution sees it. */
export interface ResolutionWalk {
  /** The accounts it received (a consistent walk's `accounts`, an inconsistent one's `observed`). */
  readonly accounts: readonly ObservedAccount[];
  /** Exact spelling → every `created_at` its rows carried (`RickpanelWalkCoverage.createdAt`). */
  readonly createdAt: ReadonlyMap<string, ReadonlySet<string>>;
  /** Gap-free, and in one relative order with a neighbouring walk. */
  readonly decisive: boolean;
}

/**
 * Every needed name, decided as of the end of the DECISION walk `walks[decision]` — a decisive
 * walk with at least one walk after it — or every name unresolved when `decision` is null.
 * Every walk's spellings count toward a collision. A spelling the decision walk returned is
 * present only when a LATER walk returned the same row (same spelling and `created_at`): it
 * existed from its read, past the decision walk's end, to that later read. Exact spellings.
 */
export function decideNeededNames(
  needed: ReadonlyMap<string, string | null>,
  walks: readonly ResolutionWalk[],
  decision: number | null,
): Map<string, NameResolution> {
  if (walks.length < 2) throw new Error('a per-name resolution needs at least two walks');
  if (
    decision !== null &&
    (!Number.isInteger(decision) || decision < 0 || decision >= walks.length - 1)
  ) {
    throw new Error('the decision walk must have a walk after it');
  }
  const spellingsOf = (accounts: readonly ObservedAccount[]) => {
    const out = new Map<string, Set<string>>();
    for (const account of accounts) {
      if (!needed.has(account.username)) continue;
      const set = out.get(account.username) ?? new Set<string>();
      set.add(account.providerUsername);
      out.set(account.username, set);
    }
    return out;
  };
  const perWalk = walks.map((w) => spellingsOf(w.accounts));
  // Every spelling any walk saw: a spelling seen once was on the panel at some moment.
  const union = new Map<string, Set<string>>();
  for (const spellings of perWalk) {
    for (const [name, set] of spellings) {
      const all = union.get(name) ?? new Set<string>();
      for (const spelling of set) all.add(spelling);
      union.set(name, all);
    }
  }
  const later = decision === null ? [] : walks.slice(decision + 1);
  const laterSpellings = decision === null ? [] : perWalk.slice(decision + 1);
  const out = new Map<string, NameResolution>();
  for (const [name, backup] of needed) {
    const seen = union.get(name);
    if (seen !== undefined && seen.size >= 2) {
      out.set(name, { kind: 'COLLISION', spellings: [...seen].sort(byCodeUnit) });
      continue;
    }
    // Two backup spellings of one name: which account each invoice meant is a guess.
    if (backup === null || decision === null) {
      out.set(name, { kind: 'UNRESOLVED' });
      continue;
    }
    const at = walks[decision] as ResolutionWalk;
    const now = perWalk[decision]?.get(name);
    const seenLater = laterSpellings.some((s) => s.has(name));
    if (now === undefined || now.size === 0) {
      // The decision walk is gap-free: nothing that existed throughout it was missed. A later
      // walk that returns the name all the same (created after, or missed after all) is not
      // overruled by a guess either way.
      out.set(name, seenLater ? { kind: 'UNRESOLVED' } : { kind: 'ABSENT' });
      continue;
    }
    // Exactly one spelling, the only one any walk saw (else a collision above). Present when a
    // later walk returned THIS row (one creation time, seen again) and no walk returned that
    // spelling with any other: a re-created account is another account, possibly another
    // customer's, and which one the backup's service belongs to is not a guess to make.
    const spelling = [...now][0] as string;
    const stamps = at.createdAt.get(spelling);
    const created = stamps !== undefined && stamps.size === 1 ? ([...stamps][0] as string) : null;
    const otherwise = later.some((w) =>
      [...(w.createdAt.get(spelling) ?? [])].some((c) => c !== created),
    );
    if (
      created !== null &&
      !otherwise &&
      later.some((w) => w.createdAt.get(spelling)?.has(created))
    ) {
      out.set(name, { kind: 'PRESENT', spelling });
      continue;
    }
    // Not returned again: deleted after its read. Absent only when a later gap-free walk
    // returned no spelling of it at all; otherwise undecided.
    out.set(
      name,
      !seenLater && later.some((w) => w.decisive) ? { kind: 'ABSENT' } : { kind: 'UNRESOLVED' },
    );
  }
  return out;
}

/** The resolution's counts, as the read reports them. */
export function resolutionCounts(resolved: ReadonlyMap<string, NameResolution>): {
  readonly present: number;
  readonly absent: number;
  readonly collisions: number;
  readonly unresolved: number;
} {
  let present = 0;
  let absent = 0;
  let collisions = 0;
  let unresolved = 0;
  for (const r of resolved.values()) {
    if (r.kind === 'PRESENT') present += 1;
    else if (r.kind === 'ABSENT') absent += 1;
    else if (r.kind === 'COLLISION') collisions += 1;
    else unresolved += 1;
  }
  return { present, absent, collisions, unresolved };
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
 * it names; a row naming NO panel, without an ADOPT yet, asks every production panel too — the
 * holders found are the panels an operator may be offered for that first ADOPT (Codex: asked
 * nothing, it could never be offered one). A test panel's row and an unmapped code ask
 * nothing — the matcher decides those without any inventory, and so does an invoice the
 * operator kept as history (`keptAsHistory`: the import never acts on it, so it must neither
 * cost a walk nor leave a panel unresolved; Codex). A superset is harmless (an extra name is only
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
  keptAsHistory: ReadonlySet<string> = new Set(),
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
    if (keptAsHistory.has(invoice.idInvoice)) continue;
    if (invoice.isTest?.trim() !== '0') continue;
    if (invoice.idUser === null || !importableUserIds.has(invoice.idUser)) continue;
    const spelling = invoice.username ?? '';
    const name = canonical(spelling);
    if (name === null) continue;
    const override = operatorPanels.get(invoice.idInvoice);
    if (override !== undefined) add(override, name, spelling);
    const raw = invoice.codePanel?.trim() ?? '';
    const code = raw === '' ? null : raw;
    if (code === null) {
      if (override === undefined) {
        for (const panelId of policy.productionPanelIds) add(panelId, name, spelling);
      }
      continue;
    }
    if (policy.testPanels.has(code)) continue;
    const mapped = policy.knownPanels.get(code);
    if (mapped !== undefined) {
      add(mapped, name, spelling);
    } else if (policy.missingPanels.has(code)) {
      for (const panelId of policy.productionPanelIds) add(panelId, name, spelling);
    }
  }
  return out;
}
