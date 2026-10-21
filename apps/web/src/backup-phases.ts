import { BACKUP_STAGES, type BackupRunSummary, type BackupStage } from '@nexa/contracts';
import type { WebKey } from './i18n/web.fa';

/** The Persian name of each pipeline stage's duration. */
export const BACKUP_PHASE_LABELS: Readonly<Record<BackupStage, WebKey>> = {
  DUMP: 'web.recovery_phase_dump',
  CHECKSUM: 'web.recovery_phase_checksum',
  ENCRYPT: 'web.recovery_phase_encrypt',
  VERIFY_RESTORE: 'web.recovery_phase_verify',
  DELIVER: 'web.recovery_phase_deliver',
  CLEANUP: 'web.recovery_phase_cleanup',
};

/**
 * The stages a run recorded a duration for, in pipeline order. A stage the run never reached
 * is absent from the list — «not run» is never shown as zero seconds.
 */
export function phaseRows(
  run: Pick<BackupRunSummary, 'phaseDurationsMs'>,
): readonly { readonly stage: BackupStage; readonly label: WebKey; readonly ms: number }[] {
  const durations = run.phaseDurationsMs;
  if (durations === null) return [];
  return BACKUP_STAGES.flatMap((stage) => {
    const ms = durations[stage];
    return ms === undefined ? [] : [{ stage, label: BACKUP_PHASE_LABELS[stage], ms }];
  });
}
