import {
  PLATFORM_ERROR_CODES,
  type BackupRunState,
  type RecoveryFailureCode,
  type RecoveryMigrationVerdict,
  type RecoveryStage,
  type RecoveryState,
} from '@nexa/contracts';
import { ApiError } from './api/client';
import { t, type WebKey } from './i18n/web.fa';

/*
 * What a recovery failure MEANS, in words an operator can act on (FIX-12, C5.9).
 *
 * The row carries a code from the closed `RECOVERY_FAILURE_CODES` vocabulary and nothing
 * else, by design (the uncontrolled text stays in the server log). The page showed that
 * code raw for 19 of the 22. A `Record` over the contract's union is what makes a code
 * added to the contract a type error here until it has words, and
 * `tests/web/recovery-failure-labels.test.ts` says the same thing at run time.
 */
export const RECOVERY_FAILURE_TEXT: Readonly<Record<RecoveryFailureCode, WebKey>> = {
  'recovery.upload_rejected': 'web.recovery_code_upload_rejected',
  'recovery.archive_malformed': 'web.recovery_code_archive_malformed',
  'recovery.archive_auth_failed': 'web.recovery_failure_auth',
  'recovery.archive_foreign_key': 'web.recovery_failure_foreign',
  'recovery.checksum_mismatch': 'web.recovery_code_checksum_mismatch',
  'recovery.manifest_invalid': 'web.recovery_code_manifest_invalid',
  'recovery.restore_test_failed': 'web.recovery_code_restore_test_failed',
  'recovery.restored_database_empty': 'web.recovery_code_restored_database_empty',
  'recovery.migration_state_unreadable': 'web.recovery_code_migration_state_unreadable',
  'recovery.migration_incompatible': 'web.recovery_code_migration_incompatible',
  'recovery.confirmation_invalid': 'web.recovery_code_confirmation_invalid',
  'recovery.emergency_backup_failed': 'web.recovery_code_emergency_backup_failed',
  'recovery.emergency_backup_busy': 'web.recovery_code_emergency_backup_busy',
  'recovery.quiesce_failed': 'web.recovery_code_quiesce_failed',
  'recovery.candidate_create_failed': 'web.recovery_code_candidate_create_failed',
  'recovery.candidate_restore_failed': 'web.recovery_code_candidate_restore_failed',
  'recovery.candidate_validation_failed': 'web.recovery_code_candidate_validation_failed',
  'recovery.cutover_failed': 'web.recovery_code_cutover_failed',
  'recovery.readiness_failed': 'web.recovery_code_readiness_failed',
  'recovery.lease_expired': 'web.recovery_code_lease_expired',
  'recovery.candidate_keys_missing': 'web.recovery_failure_keys_missing',
  'recovery.internal': 'web.recovery_code_internal',
};

/** A restored candidate's migration verdict (C1): the same five words `MigrationVerdict` uses. */
export const RECOVERY_MIGRATION_VERDICT_LABELS: Readonly<Record<RecoveryMigrationVerdict, WebKey>> =
  {
    CURRENT: 'web.recovery_verdict_current',
    AHEAD: 'web.recovery_verdict_ahead',
    BEHIND: 'web.recovery_verdict_behind',
    NONE: 'web.recovery_verdict_none',
    DIVERGED: 'web.recovery_verdict_diverged',
  };

/** The failure in words; a code this build does not know reads as the internal one. */
export function recoveryFailureText(code: string): string {
  const key = (RECOVERY_FAILURE_TEXT as Readonly<Record<string, WebKey>>)[code];
  return t(key ?? 'web.recovery_code_internal');
}

/*
 * A refused request on this page (upload, verify, confirm, run now, cancel), by its CODE.
 * The server's `message` is English and written for a log; it is never shown here.
 */
const REQUEST_ERROR_TEXT: Readonly<Record<string, WebKey>> = {
  [PLATFORM_ERROR_CODES.RECOVERY_REFUSED]: 'web.recovery_error_refused',
  [PLATFORM_ERROR_CODES.RECOVERY_ALREADY_ACTIVE]: 'web.recovery_error_already_active',
  [PLATFORM_ERROR_CODES.RECOVERY_QUIESCED]: 'web.recovery_quiesced',
  [PLATFORM_ERROR_CODES.RECOVERY_CONFIRMATION_INVALID]: 'web.recovery_code_confirmation_invalid',
  [PLATFORM_ERROR_CODES.BACKUP_ALREADY_RUNNING]: 'web.recovery_run_busy',
  [PLATFORM_ERROR_CODES.BACKUP_RUN_MISSING]: 'web.recovery_error_run_missing',
  [PLATFORM_ERROR_CODES.PERMISSION_DENIED]: 'web.recovery_error_permission',
  [PLATFORM_ERROR_CODES.IDEMPOTENCY_IN_FLIGHT]: 'web.recovery_error_in_flight',
  // A Mirza package import holds the installation (#278): said in Persian, with what to do.
  [PLATFORM_ERROR_CODES.RECOVERY_LEGACY_MIGRATION_ACTIVE]:
    'web.recovery_fault_legacy_migration_active',
};

/** Any error from this page's requests, as safe Persian; never a raw exception. */
export function recoveryErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return t('web.error');
  /*
   * `recovery.refused` is several different refusals. The service's own refusals carry the
   * failure code in `details.failureCode` (a verify of a request whose uploaded file is no
   * longer on the server is `recovery.upload_rejected`), and that code has the precise words.
   * The rest — uploads disabled on this installation (a page opened before the setting
   * changed, or a replica that disagrees), an oversized or empty upload, an unknown id —
   * carry none, and some of them happen before any recovery row exists, so the generic
   * sentence must not promise one.
   */
  if (error.code === PLATFORM_ERROR_CODES.RECOVERY_REFUSED) {
    const failureCode = error.details?.['failureCode'];
    if (typeof failureCode === 'string' && failureCode in RECOVERY_FAILURE_TEXT) {
      return recoveryFailureText(failureCode);
    }
  }
  const key = REQUEST_ERROR_TEXT[error.code];
  if (key !== undefined) return t(key);
  // A recovery failure code answered directly is still one of the 22.
  if (error.code in RECOVERY_FAILURE_TEXT) return recoveryFailureText(error.code);
  return `${t('web.recovery_error_generic')} (${error.code})`;
}

/**
 * W5: recovery request states, pipeline stages and backup run states as Persian names.
 * Total over the contract's lists (a new state without a name is a compile error); the
 * page keeps the raw value in the tooltip.
 */
export const RECOVERY_STATE_LABELS: Readonly<Record<RecoveryState, WebKey>> = {
  UPLOADED: 'web.recovery_state_uploaded',
  VERIFYING: 'web.recovery_state_verifying',
  VERIFIED: 'web.recovery_state_verified',
  RESTORE_TESTING: 'web.recovery_state_restore_testing',
  RESTORE_TEST_PASSED: 'web.recovery_state_restore_test_passed',
  RESTORE_REQUESTED: 'web.recovery_state_restore_requested',
  PRE_RESTORE_BACKUP: 'web.recovery_state_pre_restore_backup',
  QUIESCING: 'web.recovery_state_quiescing',
  RESTORING: 'web.recovery_state_restoring',
  VALIDATING: 'web.recovery_state_validating',
  CUTTING_OVER: 'web.recovery_state_cutting_over',
  RESTARTING: 'web.recovery_state_restarting',
  SUCCEEDED: 'web.recovery_state_succeeded',
  FAILED: 'web.recovery_state_failed',
};

export const RECOVERY_STAGE_LABELS: Readonly<Record<RecoveryStage, WebKey>> = {
  RECEIVE_UPLOAD: 'web.recovery_stage_receive_upload',
  PARSE_CONTAINER: 'web.recovery_stage_parse_container',
  DECRYPT: 'web.recovery_stage_decrypt',
  CHECKSUM: 'web.recovery_stage_checksum',
  MANIFEST: 'web.recovery_stage_manifest',
  SCRATCH_RESTORE: 'web.recovery_stage_scratch_restore',
  SCRATCH_INSPECT: 'web.recovery_stage_scratch_inspect',
  AWAIT_CONFIRMATION: 'web.recovery_stage_await_confirmation',
  EMERGENCY_BACKUP: 'web.recovery_stage_emergency_backup',
  QUIESCE: 'web.recovery_stage_quiesce',
  CREATE_CANDIDATE: 'web.recovery_stage_create_candidate',
  RESTORE_CANDIDATE: 'web.recovery_stage_restore_candidate',
  MIGRATE_CANDIDATE: 'web.recovery_stage_migrate_candidate',
  VALIDATE_CANDIDATE: 'web.recovery_stage_validate_candidate',
  CUTOVER: 'web.recovery_stage_cutover',
  READINESS: 'web.recovery_stage_readiness',
  CLEANUP: 'web.recovery_stage_cleanup',
  DONE: 'web.recovery_stage_done',
};

export const BACKUP_RUN_STATE_LABELS: Readonly<Record<BackupRunState, WebKey>> = {
  RUNNING: 'web.backup_run_state_running',
  SUCCEEDED: 'web.backup_run_state_succeeded',
  FAILED: 'web.backup_run_state_failed',
};
