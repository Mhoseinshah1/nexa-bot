import type { BackupTrigger } from '@nexa/contracts';
import type { BackupPort } from '../application/ports.js';

/**
 * The backup after a completed import (design §4): `container.backup.run('MANUAL')`, the call
 * `backup.cli.ts` makes — a SYSTEM_JOB may not call `BackupAdminService.run`, which needs
 * `backup.run` — after the same quiesce question every backup trigger asks
 * (`container.recoveryQuiesced`): a recovery holding the installation means no backup now.
 */
export class PipelineBackupPort implements BackupPort {
  constructor(
    private readonly pipeline: {
      run(trigger: BackupTrigger): Promise<
        | { readonly kind: 'BUSY'; readonly holder: { readonly id: string } }
        | {
            readonly kind: 'COMPLETED';
            readonly run: { readonly id: string; readonly state: string };
          }
      >;
    },
    private readonly quiesced: () => Promise<boolean>,
  ) {}

  async runAfterImport(): ReturnType<BackupPort['runAfterImport']> {
    if (await this.quiesced()) return { outcome: 'SKIPPED_QUIESCED', runId: null };
    const outcome = await this.pipeline.run('MANUAL');
    if (outcome.kind === 'BUSY') return { outcome: 'BUSY', runId: outcome.holder.id };
    return {
      outcome: outcome.run.state === 'SUCCEEDED' ? 'TAKEN' : 'FAILED',
      runId: outcome.run.id,
    };
  }
}
