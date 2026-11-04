import {
  LEGACY_CLEANUP_BLOCKING_DIFFERENCES,
  legacyBalanceReconciliationSchema,
} from '@nexa/contracts';

/**
 * v0.9.7 PR-1: whether a finished import's recorded balance reconciliation lets the cleanup
 * run (`docs/legacy-migration/compaction.md`, «پاک‌سازی خودکار»). PURE.
 *
 * Clean means: a reconciliation was recorded (`apply_report.balanceReconciliation`), it has
 * the shape the contract names, and it counts ZERO of every blocking kind
 * (`LEGACY_CLEANUP_BLOCKING_DIFFERENCES`: a wallet that is not the Mirza balance, a Mirza
 * customer missing in Nexa, an agent's credit inside a wallet). A missing reconciliation — a
 * report recorded before it existed, or one that could not be computed — is NOT clean: the
 * cleanup deletes the map a person would need to look into a difference, so an unknown is
 * never read as "no difference". A missing kind is not zero either.
 */
export function balanceReconciliationClean(recorded: unknown): boolean {
  if (recorded === null || recorded === undefined) return false;
  const parsed = legacyBalanceReconciliationSchema.safeParse(recorded);
  if (!parsed.success) return false;
  return LEGACY_CLEANUP_BLOCKING_DIFFERENCES.every((kind) => parsed.data.differences[kind] === 0);
}
