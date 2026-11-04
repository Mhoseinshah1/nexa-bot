/**
 * The tables whose DATA a backup leaves out (v0.9.7 PR-2), each with the reason a restorer
 * reads in the archive's manifest. A CLOSED list, held by `tests/unit/backup-exclusions.test.ts`.
 *
 * THE SCHEMA IS NEVER LEFT OUT. `pg_dump --exclude-table-data` keeps every table, column,
 * index, constraint and trigger; a restore produces the same database with these tables
 * empty. Nothing is excluded by prefix, by pattern or because a table "looks transient": a
 * table is here only when losing EVERY row of it on a restore costs nothing but a retry,
 * and that is said per table below.
 *
 * WHAT IS DELIBERATELY NOT HERE, and why — the short-lived tables the v0.9.7 round named,
 * which `pg_dump` can only keep or drop WHOLE (it has no row filter):
 *
 * - `outbox_messages`: published history is harmless to lose, but the same table holds every
 *   message not yet published, and an unpublished message is work. Its published history is
 *   bounded at the source instead: the E3 sweeper removes it after
 *   `retention.outbox_published_days` (7), so a dump carries only that window.
 * - `request_idempotency`: interactive keys are harmless to lose, but `WORKER`, `SCHEDULER`
 *   and `API` keys are the re-run safety of the importer and the money jobs. The interactive
 *   ones are bounded by the E3 sweeper (`retention.idempotency_interactive_days`, 7).
 * - `notification_delivery_attempts` / `notification_released_claims`: a finished
 *   notification without its attempt breaks the dispatcher's invariant that a SENT or FAILED
 *   intent has one, and a PENDING one's attempts are its concurrency guard. Bounded by the
 *   data compaction (`retention.ops_notifications_days`, 7, APPLY by default).
 * - `processed_messages`: the consumers' dedupe ledger (ADR-0025's own example).
 */
export interface BackupTableDataExclusion {
  /** An unqualified table in `public`. */
  readonly table: string;
  /** Why losing every row of it on a restore is harmless. Carried in the manifest. */
  readonly reason: string;
}

export const BACKUP_TABLE_DATA_EXCLUSIONS: readonly BackupTableDataExclusion[] = [
  {
    table: 'admin_login_throttle',
    reason:
      'Login rate-limit counters (failed sign-ins per username and per address). A restore ' +
      'starts every counter afresh; no account, session or permission depends on a row.',
  },
  {
    table: 'panel_probe_claims',
    reason:
      'When a panel connection test was last allowed to start. A restore allows the next test ' +
      'at once; panel health, credentials and every service are kept.',
  },
] as const;

/** The `pg_dump` arguments for the list: one `--exclude-table-data` per table, schema-qualified. */
export function excludeTableDataArgs(
  exclusions: readonly BackupTableDataExclusion[] = BACKUP_TABLE_DATA_EXCLUSIONS,
): string[] {
  return exclusions.map((entry) => `--exclude-table-data=public.${entry.table}`);
}

/** The manifest's entries for the list (`BackupManifest.exclusions`). */
export function manifestExclusions(
  exclusions: readonly BackupTableDataExclusion[] = BACKUP_TABLE_DATA_EXCLUSIONS,
): { object: string; reason: string }[] {
  return exclusions.map((entry) => ({
    object: `table data: public.${entry.table}`,
    reason: entry.reason,
  }));
}
