import { createHash } from 'node:crypto';
import {
  LEGACY_MIGRATION_COMMAND_STATES,
  LEGACY_MIGRATION_PHASES,
  LEGACY_NXPKG_TERMINAL_STATUSES,
  type LegacyMigrationPhase,
  type LegacyMigrationProgress,
  type LegacyNxpkgImportStatus,
} from '@nexa/contracts';

/**
 * Mirza `.nxpkg` importer — the lifecycle of one `legacy_nxpkg_imports` row
 * (`docs/legacy-migration/nxpkg-importer.md` §4).
 *
 * ```
 * UPLOADED → VERIFYING → VERIFIED | VERIFY_FAILED
 * VERIFIED → DRY_RUN_REQUESTED → DRY_RUN_RUNNING → DRY_RUN_DONE | DRY_RUN_FAILED
 * DRY_RUN_DONE → APPROVED (binds dry_run_sha256) → APPLYING → COMPLETED | COMPLETED_WITH_DISCREPANCY | FAILED
 * any non-terminal except APPLYING → CANCELLED
 * ```
 *
 * Two edges are not in the design's diagram and both exist so a decision cannot outlive what
 * it decided about:
 *
 * - `DRY_RUN_DONE → VERIFIED`: a panel binding or a decisions file changed after the dry run.
 *   The dry run's report and digest are cleared, so no approval can bind a report computed
 *   from inputs that are no longer the import's.
 * - `DRY_RUN_DONE → DRY_RUN_REQUESTED`: the operator asks for the dry run again.
 *
 * `DRY_RUN_REQUESTED → DRY_RUN_FAILED` and `APPROVED → FAILED` are a production-like target's
 * precheck refusing what is never allowed (a synthetic package), before anything ran or wrote.
 *
 * APPLYING is NOT cancellable. Writes may already have committed; the importer's resume is
 * what finishes them (`importer.md` §6), and a cancelled half-import would have no owner to
 * resume it. An APPLYING row runs to COMPLETED, COMPLETED_WITH_DISCREPANCY or FAILED.
 *
 * Every state change is a conditional UPDATE naming these `from` states (the recovery rule):
 * a replay, a double-click and two `migration` replicas are all safe by that one mechanism.
 */
export const LEGACY_MIGRATION_TRANSITIONS: Readonly<
  Record<LegacyNxpkgImportStatus, readonly LegacyNxpkgImportStatus[]>
> = {
  UPLOADED: ['VERIFYING', 'CANCELLED'],
  VERIFYING: ['VERIFIED', 'VERIFY_FAILED', 'CANCELLED'],
  VERIFIED: ['DRY_RUN_REQUESTED', 'CANCELLED'],
  VERIFY_FAILED: [],
  DRY_RUN_REQUESTED: ['DRY_RUN_RUNNING', 'DRY_RUN_FAILED', 'CANCELLED'],
  DRY_RUN_RUNNING: ['DRY_RUN_DONE', 'DRY_RUN_FAILED', 'CANCELLED'],
  DRY_RUN_DONE: ['APPROVED', 'VERIFIED', 'DRY_RUN_REQUESTED', 'CANCELLED'],
  DRY_RUN_FAILED: [],
  APPROVED: ['APPLYING', 'FAILED', 'CANCELLED'],
  APPLYING: ['COMPLETED', 'COMPLETED_WITH_DISCREPANCY', 'FAILED'],
  COMPLETED: [],
  COMPLETED_WITH_DISCREPANCY: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransition(from: LegacyNxpkgImportStatus, to: LegacyNxpkgImportStatus): boolean {
  return LEGACY_MIGRATION_TRANSITIONS[from].includes(to);
}

/** The states whose `error_code` is required (and the only ones that may carry one). */
export const LEGACY_MIGRATION_FAILURE_STATUSES = [
  'VERIFY_FAILED',
  'DRY_RUN_FAILED',
  'FAILED',
  'CANCELLED',
] as const satisfies readonly LegacyNxpkgImportStatus[];

export function isLegacyMigrationFailure(status: LegacyNxpkgImportStatus): boolean {
  return (LEGACY_MIGRATION_FAILURE_STATUSES as readonly string[]).includes(status);
}

export function isLegacyMigrationTerminal(status: LegacyNxpkgImportStatus): boolean {
  return (LEGACY_NXPKG_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * The states with work for the `migration` role. A claim takes one of these whose lease is
 * free (or its own after a restart); an `UPLOADED` row only once its key is held.
 *
 * The three in-progress states are here on purpose: a crashed worker's VERIFYING or
 * DRY_RUN_RUNNING is simply run again (both are read-only and repeatable), and its APPLYING
 * is RESUMED — see `LegacyMigrationExecutor`.
 */
export const LEGACY_MIGRATION_WORK_STATUSES = [
  'UPLOADED',
  'VERIFYING',
  'DRY_RUN_REQUESTED',
  'DRY_RUN_RUNNING',
  'APPROVED',
  'APPLYING',
] as const satisfies readonly LegacyNxpkgImportStatus[];

/**
 * What each operator command may start from — the contract's table, so the server's checks
 * and the Web Admin's offers are one statement. Every command also requires no live lease,
 * except `cancel`.
 */
export const LEGACY_MIGRATION_COMMAND_FROM = LEGACY_MIGRATION_COMMAND_STATES;

/**
 * The worker lease. Heartbeated every minute while a step runs; a lease five minutes past its
 * last heartbeat belongs to a process that stopped, and is released for the next claim.
 */
export const LEGACY_MIGRATION_LEASE_MS = 5 * 60_000;
export const LEGACY_MIGRATION_LEASE_HEARTBEAT_MS = 60_000;

/**
 * Canonical JSON: object keys in UTF-16 code-unit order at every depth, no whitespace, arrays in
 * order. What `dry_run_sha256` is computed over, so a report stored in `jsonb` (which
 * reorders keys) hashes to the same digest when it is read back.
 *
 * Refuses anything JSON cannot round-trip — a non-finite number, a bigint, `undefined` in an
 * array, a function — rather than hashing a string `JSON.stringify` made up for it.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: a non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value
          .map((item) => {
            if (item === undefined) throw new TypeError('canonicalJson: undefined in an array');
            return canonicalJson(item);
          })
          .join(',')}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: a ${typeof value} is not JSON`);
  }
}

/** SHA-256 (lowercase hex) of a report's canonical JSON: the digest an approval binds. */
export function reportDigest(report: unknown): string {
  return createHash('sha256').update(canonicalJson(report), 'utf8').digest('hex');
}

/** Compares two hex digests without an early exit. */
export function digestsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

/** A new import's progress: no phase reached, nothing recorded. */
export const EMPTY_LEGACY_MIGRATION_PROGRESS: LegacyMigrationProgress = {
  phase: null,
  applyAttempts: 0,
  verifyAttempts: 0,
  dryRunAttempts: 0,
  importerVerdict: null,
  reconcileVerdict: null,
  history: [],
  refusalCounts: [],
  backup: null,
  blocker: null,
};

/** Whether `reached` is at or past `phase` in the apply's fixed order. */
export function phaseReached(
  reached: LegacyMigrationPhase | null,
  phase: LegacyMigrationPhase,
): boolean {
  if (reached === null) return false;
  return LEGACY_MIGRATION_PHASES.indexOf(reached) >= LEGACY_MIGRATION_PHASES.indexOf(phase);
}

/**
 * How many times an apply may be started or resumed before an error the runner did not
 * classify is taken as the verdict. A crash resumes; a crash LOOP is a failure an owner must
 * read, not a process that retries for ever.
 */
export const LEGACY_MIGRATION_MAX_APPLY_ATTEMPTS = 5;

/**
 * The same bound for VERIFY and the DRY RUN. Both are read-only and simply run again after a
 * crash or an error nobody classified — but not for ever: past the bound the step is failed
 * (`VERIFY_FAILED` / `DRY_RUN_FAILED`, `IMPORT_FAILED`) and the key is erased.
 */
export const LEGACY_MIGRATION_MAX_STEP_ATTEMPTS = 5;

/**
 * Key expiry (`LEGACY_MIGRATION_KEY_IDLE_MS`): the states in which an import waits on a PERSON,
 * never on the `migration` role. A sealed key left there longer than the idle period is
 * erased; the operator gives it again (`setKey` accepts these states while no key is held).
 */
export const LEGACY_MIGRATION_KEY_IDLE_STATUSES = [
  'VERIFIED',
  'DRY_RUN_DONE',
] as const satisfies readonly LegacyNxpkgImportStatus[];

/** The default idle period before a waiting import's sealed key is erased: one day. */
export const LEGACY_MIGRATION_KEY_IDLE_MS_DEFAULT = 24 * 60 * 60_000;

/**
 * What a log line may say about an error: its type and its code — never its message, which
 * for a filesystem error carries a path under `LEGACY_MIGRATION_WORK_DIR` (L3), and for an
 * importer error may carry a value from the package.
 */
export function errorKind(error: unknown): { readonly type: string; readonly code: string | null } {
  if (!(error instanceof Error)) return { type: typeof error, code: null };
  const code = (error as { code?: unknown }).code;
  return {
    type: error.name === 'Error' ? error.constructor.name : error.name,
    code: typeof code === 'string' || typeof code === 'number' ? String(code) : null,
  };
}
