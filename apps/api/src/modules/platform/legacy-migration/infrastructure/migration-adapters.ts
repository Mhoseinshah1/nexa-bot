import type { BackupTrigger } from '@nexa/contracts';
import type { BackupPort } from '../application/ports.js';

/**
 * The backups around an import, through the unmodified Backup V1 pipeline (`BackupService.run`,
 * the call `backup.cli.ts` makes — a SYSTEM_JOB may not call `BackupAdminService.run`, which
 * needs `backup.run`).
 *
 * - BEFORE (Phase 7, mandatory): `run('PRE_RESTORE')`, the trigger the recovery executor's
 *   emergency backup uses — a migration IS a restore from the operator's view, and the backup
 *   is what undoes it. `TAKEN` only for a run that SUCCEEDED with a non-null `verifiedAt` (the
 *   pipeline's VERIFY_RESTORE passed), exactly the recovery executor's test; anything else is
 *   not a protective backup.
 * - AFTER (design §4): `run('MANUAL')`, after the same quiesce question every backup trigger
 *   asks (`container.recoveryQuiesced`): a recovery holding the installation means no backup now.
 */
/** Both backups stay on this server: a Mirza restore sends nothing to Telegram. */
const LOCAL_ONLY = { deliver: false } as const;

export class PipelineBackupPort implements BackupPort {
  constructor(
    private readonly pipeline: {
      run(
        trigger: BackupTrigger,
        options?: { readonly deliver?: boolean },
      ): Promise<
        | { readonly kind: 'BUSY'; readonly holder: { readonly id: string } }
        | {
            readonly kind: 'COMPLETED';
            readonly run: {
              readonly id: string;
              readonly state: string;
              readonly verifiedAt: Date | null;
            };
          }
      >;
    },
    private readonly quiesced: () => Promise<boolean>,
  ) {}

  async runBeforeImport(): ReturnType<BackupPort['runBeforeImport']> {
    const outcome = await this.pipeline.run('PRE_RESTORE', LOCAL_ONLY);
    if (outcome.kind === 'BUSY') return { outcome: 'BUSY', runId: outcome.holder.id };
    return {
      outcome:
        outcome.run.state === 'SUCCEEDED' && outcome.run.verifiedAt !== null ? 'TAKEN' : 'FAILED',
      runId: outcome.run.id,
    };
  }

  async runAfterImport(): ReturnType<BackupPort['runAfterImport']> {
    if (await this.quiesced()) return { outcome: 'SKIPPED_QUIESCED', runId: null };
    const outcome = await this.pipeline.run('MANUAL', LOCAL_ONLY);
    if (outcome.kind === 'BUSY') return { outcome: 'BUSY', runId: outcome.holder.id };
    return {
      outcome: outcome.run.state === 'SUCCEEDED' ? 'TAKEN' : 'FAILED',
      runId: outcome.run.id,
    };
  }
}
