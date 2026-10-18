import type { ActorContext, TenantContext } from '@nexa/contracts';

/**
 * The one-time Mirza import, after the importer's own phases (customers, openings, trials,
 * products, adoption): what is left of the Mirza backup is carried into NEXA's NORMAL tables
 * as HISTORY, marked `source = 'MIRZA'` with its Mirza id in `source_ref`
 * (`docs/migration/mirza-import-plan-fa.md` §3, §5).
 *
 * Each table is one STEP. A step reads what the package archived (`legacy_history_records`,
 * `legacy_invoice_archive`) and the importer's map (`legacy_import_map`), and writes rows
 * directly through its own repository — never through a business service — so nothing it
 * writes reaches the outbox, a notification, a reminder, a provider or the ledger.
 *
 * Three rules every step keeps, each tested:
 * - NO MONEY. A step never writes `wallet_entries`; the opening balance is the only money the
 *   import moves. A step's rows are history and change no balance.
 * - IDEMPOTENT. Every row is keyed by `(tenant_id, source_ref)`; `apply` twice writes nothing
 *   the second time (`ON CONFLICT DO NOTHING`), and a row already present with different
 *   content is reported as `diverged`, never rewritten.
 * - EVERY SOURCE ROW IS ACCOUNTED. `match` answers, per Mirza table, how many rows (and how
 *   much money, where the table carries an amount) the package holds and NEXA holds, and
 *   names a reason for every row that is not carried.
 */
export interface MaterializeContext {
  readonly scope: TenantContext;
  /** `SYSTEM_JOB`: the migration's actor. */
  readonly actor: ActorContext;
  /** The package import whose archive is read (`legacy_nxpkg_imports.id`). */
  readonly packageImportId: string;
  /** The source fingerprint the archive was recorded under. */
  readonly sourceFingerprint: string;
  readonly now: Date;
}

/** Why a Mirza row is not a NEXA row. A closed, per-step vocabulary of UPPER_SNAKE codes. */
export interface ExplainedGap {
  readonly reason: string;
  readonly rows: number;
  /** Minor units (IRT), when the table carries an amount; else null. */
  readonly sumMinor: bigint | null;
}

/** One row of the exact-match report: one Mirza table against the NEXA table it became. */
export interface ExactMatchRow {
  /** The Mirza side, as the package names it (e.g. `invoice`, `payments`, `tickets`). */
  readonly mirzaTable: string;
  /** The NEXA table its rows became (e.g. `orders`, `payments`). */
  readonly nexaTable: string;
  readonly mirzaRows: number;
  readonly nexaRows: number;
  /** Null when the table carries no amount. */
  readonly mirzaSumMinor: bigint | null;
  readonly nexaSumMinor: bigint | null;
  /** Every row the package holds and NEXA does not, with its reason. */
  readonly explained: readonly ExplainedGap[];
}

export interface MaterializeStepOutcome {
  readonly step: string;
  /** Rows this call wrote. */
  readonly written: number;
  /** Rows already present with the same content (a rerun). */
  readonly alreadyPresent: number;
  /** Rows present with DIFFERENT content: never rewritten, always a blocking difference. */
  readonly diverged: number;
  readonly skipped: Readonly<Record<string, number>>;
}

export interface MaterializeStep {
  readonly name: string;
  apply(ctx: MaterializeContext): Promise<MaterializeStepOutcome>;
  /** Read only. */
  match(ctx: MaterializeContext): Promise<readonly ExactMatchRow[]>;
}

/**
 * A row is EXACT when NEXA holds what Mirza held once every explained gap is added back:
 * rows and, where there is an amount, money. Anything else is an unexplained difference,
 * and the import is not COMPLETE while one exists.
 */
export function exactMatchHolds(row: ExactMatchRow): boolean {
  const rows = row.nexaRows + row.explained.reduce((a, g) => a + g.rows, 0);
  if (rows !== row.mirzaRows) return false;
  if (row.mirzaSumMinor === null) return row.nexaSumMinor === null;
  const explainedSum = row.explained.reduce((a, g) => a + (g.sumMinor ?? 0n), 0n);
  return row.nexaSumMinor !== null && row.nexaSumMinor + explainedSum === row.mirzaSumMinor;
}
