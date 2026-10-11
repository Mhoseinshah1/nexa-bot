/**
 * Mirza `.nxpkg` importer — the FRESH TARGET guard's verdict
 * (`docs/legacy-migration/nxpkg-importer.md` §6). WHICH tables are counted, and how, is the
 * infrastructure's (`infrastructure/nxpkg-fresh-target.ts`, `FRESH_TARGET_TABLES`); the importer
 * only asks for the counts inside the transaction that starts an APPLY run
 * (`LegacyImporterDestination.freshTargetCounts`, tenant row locked) and refuses a non-zero one.
 * Counts only: no amount, no key, no person.
 */

export interface FreshTargetCheck {
  readonly fresh: boolean;
  /** Rows per counted table (every table, zero included). */
  readonly counts: Readonly<Record<string, number>>;
  /** `FRESH_TARGET_NOT_EMPTY` when not fresh, else null. */
  readonly code: 'FRESH_TARGET_NOT_EMPTY' | null;
}

export interface FreshTargetOptions {
  /** The source being imported: its own read-set rows are not counted. Null counts every row. */
  readonly sourceFingerprint: string | null;
  /** The APPLY run being started (its own row is not "an earlier import"). */
  readonly excludeRunId?: string | null;
}

/** The verdict from the counts. */
export function freshTargetVerdict(counts: Readonly<Record<string, number>>): FreshTargetCheck {
  const fresh = Object.values(counts).every((n) => n === 0);
  return { fresh, counts, code: fresh ? null : 'FRESH_TARGET_NOT_EMPTY' };
}

/** The non-zero counts, sorted by table, as a refusal states them. */
export function freshTargetProblems(check: FreshTargetCheck): string[] {
  return Object.entries(check.counts)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([t, n]) => `${t}: ${String(n)} row(s)`);
}
