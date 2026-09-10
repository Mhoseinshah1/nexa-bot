import { errors, isSystemContext, PLATFORM_ERROR_CODES, type ScopeContext } from '@nexa/contracts';

/**
 * The installation-wide write gate.
 *
 * ADR-0028 § 5. While a destructive recovery is quiescing the installation, new
 * durable writes are refused — and the refusal is HERE, at the two chokepoints
 * every durable write actually passes through, rather than at the ten call sites
 * that consult `ScopeActivityReader`.
 *
 * That placement is the whole point, and it is a response to something this
 * codebase has already learned twice. `CLAUDE.md` records that panels was the one
 * module that skipped the scope-activity check, which let a tenant an operator
 * had stopped be given new panels and a background monitor. A rule applied at
 * every call site is a rule that will be missing from the next call site; a rule
 * applied where the transaction is opened cannot be.
 *
 * WHY NOT `ScopeActivityReader`. That port reads one tenant's status, and a
 * recovery is not a tenant being stopped — it is the installation being
 * replaced. Folding the two together would make every write path's refusal say
 * "this tenant is not accepting work" during a restore, which sends an operator
 * to the one place the answer is not. They are separate questions with separate
 * codes, and both still apply.
 *
 * WHAT IS NOT GATED, deliberately:
 *
 *   - READS. `runSnapshot` is the consistent-read path and is untouched. The
 *     instruction is explicit that reads and status may remain, and it matters
 *     that they do: an operator supervising a recovery is reading.
 *   - The RECOVERY LANE itself, which has to write its own progress while the
 *     installation is shut. Recognised by its scope — `systemContext('recovery')`
 *     — rather than by an option a caller could pass, because an option is
 *     something a future call site passes by accident and a scope is something a
 *     reviewer sees.
 *   - The PRE-RESTORE BACKUP, which runs before the quiesce window opens
 *     (`RECOVERY_QUIESCING_STATES` deliberately excludes
 *     `PRE_RESTORE_BACKUP`). It writes to `backup_runs`, to
 *     `operational_events` and to the outbox, and an installation that refused
 *     writes during it could not take the backup that makes the rest of the
 *     operation recoverable.
 */

/**
 * The scope reason the recovery lane writes under.
 *
 * A constant rather than a string literal at two call sites, because the gate and
 * the executor have to agree on it exactly and a typo would be an executor that
 * cannot write its own progress — during a quiesce, which is the one time
 * nothing else can write it for them.
 */
export const RECOVERY_SCOPE_REASON = 'recovery';

/** Whether this scope is the recovery lane, and therefore exempt. */
export function isRecoveryLane(scope: ScopeContext): boolean {
  return isSystemContext(scope) && scope.reason === RECOVERY_SCOPE_REASON;
}

/**
 * What the gate needs to know, as a question rather than a repository.
 *
 * Narrow on purpose: the unit of work must not depend on the recovery module, or
 * the dependency graph runs from infrastructure into a feature. It depends on
 * one question, and the recovery repository happens to answer it.
 */
export interface InstallationWriteGate {
  /**
   * Whether writes are currently refused, read INSIDE `tx`.
   *
   * Inside, not before: a quiesce that commits between a check and the write it
   * guards would otherwise be overtaken, which is the same reasoning
   * `ScopeActivityReader` is consulted inside the transaction for.
   */
  quiescedBy(tx: unknown): Promise<string | null>;
}

/**
 * Refuses the transaction if the installation is quiesced.
 *
 * Throws a CONFLICT rather than a validation error: the caller did nothing
 * wrong, and the correct client behaviour is to try again once the recovery has
 * finished. The recovery id is in the message because an operator seeing this on
 * a settings page needs to know which operation is in the way, and a recovery id
 * is not a secret — it is in their own URL.
 */
export async function assertInstallationWritable(
  gate: InstallationWriteGate,
  scope: ScopeContext,
  tx: unknown,
): Promise<void> {
  if (isRecoveryLane(scope)) return;
  const recoveryId = await gate.quiescedBy(tx);
  if (recoveryId === null) return;
  throw errors.conflict(
    PLATFORM_ERROR_CODES.RECOVERY_QUIESCED,
    'This installation is being restored from a backup and is not accepting changes. ' +
      `Recovery ${recoveryId} is in progress.`,
  );
}

/**
 * The gate an installation with no recovery module has.
 *
 * Used by the migrator and by any entrypoint that builds a partial graph. It is
 * an explicit value rather than an optional parameter so that "this process does
 * not gate writes" is a decision somebody wrote down, and a `gate === undefined`
 * branch cannot quietly become the default for a process that should have one.
 */
export const UNGATED: InstallationWriteGate = {
  async quiescedBy() {
    return null;
  },
};
