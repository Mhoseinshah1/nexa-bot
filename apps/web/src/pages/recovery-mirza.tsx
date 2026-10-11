import { useId, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BACKUP_ARCHIVE_MAGIC,
  isLegacyNxpkgTerminalStatus,
  LEGACY_MIGRATION_COMMAND_STATES,
  type LegacyMigrationBackupOutcome,
  type LegacyMigrationBlocker,
  type LegacyMigrationCapabilitiesResponse,
  type LegacyMigrationCodeCount,
  type LegacyMigrationImportView,
  type LegacyMigrationPhase,
  type LegacyMigrationSectionCounts,
  type LegacyNxpkgErrorCode,
  type LegacyNxpkgImportStatus,
  type PermissionKey,
} from '@nexa/contracts';
import {
  ApiError,
  approveLegacyMigration,
  cancelLegacyMigration,
  fetchLegacyMigrationCapabilities,
  fetchLegacyMigrationImports,
  fetchPanels,
  requestLegacyMigrationDryRun,
  setLegacyMigrationKey,
  setLegacyMigrationPanelBindings,
  uploadLegacyMigrationDecisions,
} from '../api/client';
import { formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { pollUnlessFinalWhile } from '../polling';
import { useLinkHandler } from '../router';
import { useSubmissionKey } from '../submission-key';
import { messageFor } from './settings';
import {
  Badge,
  Banner,
  Button,
  Copyable,
  DataTable,
  Disclosure,
  Field,
  Input,
  KV,
  Ltr,
  Num,
  Select,
  Textarea,
  type Column,
  type Tone,
} from '../ui/kit';
import { Icon } from '../ui/icons';

/**
 * Restore from Mirza — the second source of «بکاپ و بازیابی ← عملیات بازیابی»
 * (`docs/legacy-migration/nxpkg-importer.md`, the restore-page path).
 *
 * The converter's output is an authenticated `.nxpkg`, never an `.nxb`: an offline converter
 * cannot hold this installation's key, so the restore page accepts the package as a second
 * source and the EXISTING `recovery` process role runs the EXISTING nxpkg migration engine.
 * This file is the page half of that: the same import row the old «مهاجرت از میرزا» page
 * drove, shown as four steps inside the restore card — upload · review · confirm · run and
 * result.
 *
 * Nothing here opens a package. The key is write-only (the page is told only that one is
 * held); no path, no legacy row and no personal data is ever shown — counts, codes and
 * digests. The confirmation carries the dry run's digest the owner READ, the typed phrase and
 * the installation's target acknowledgement from the capabilities, and the server decides all
 * three again. Before any write the recovery role takes a protective backup of this
 * installation; the result names it, and restoring it on this same page is the undo.
 *
 * Permissions: `legacy.migration.view` to see it, `legacy.migration.manage` to upload, give
 * the key, bind the panels and request a dry run, the CRITICAL `legacy.migration.apply` to
 * confirm. A control the actor may not use is not offered; the server refuses it anyway.
 */

const POLL_MS = 5_000;

// --- which restore source a file is ------------------------------------------------------------

/** The `.nxpkg` container's magic, `NXPKG\0` (`apps/api/src/infrastructure/nxpkg/crypto.ts`). */
const NXPKG_MAGIC: readonly number[] = [0x4e, 0x58, 0x50, 0x4b, 0x47, 0x00];

export type RestoreFileKind = 'NEXA' | 'MIRZA' | 'UNKNOWN';

/**
 * What a chosen file is, from its first eight bytes — never from its name: `NEXABAK1` is a
 * NEXA backup archive (the existing restore, unchanged), `NXPKG\0` a converter package (the
 * Mirza flow), anything else neither. A courtesy that routes the file to the right endpoint;
 * each server path authenticates what it receives.
 */
export async function sniffRestoreFile(file: Blob): Promise<RestoreFileKind> {
  const head = await headOf(file.slice(0, 8));
  const starts = (magic: readonly number[]) =>
    head.length >= magic.length && magic.every((byte, index) => head[index] === byte);
  const nexa = Array.from(BACKUP_ARCHIVE_MAGIC, (char) => char.charCodeAt(0));
  if (starts(nexa)) return 'NEXA';
  if (starts(NXPKG_MAGIC)) return 'MIRZA';
  return 'UNKNOWN';
}

/** A small blob's bytes: `arrayBuffer()` where the platform has it, `FileReader` otherwise. */
function headOf(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(
        reader.result instanceof ArrayBuffer ? new Uint8Array(reader.result) : new Uint8Array(),
      );
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsArrayBuffer(blob);
  });
}

// --- labels --------------------------------------------------------------------------------------

const STATUS_LABELS: Readonly<Record<LegacyNxpkgImportStatus, WebKey>> = {
  UPLOADED: 'web.lmg_status_uploaded',
  VERIFYING: 'web.lmg_status_verifying',
  VERIFIED: 'web.lmg_status_verified',
  VERIFY_FAILED: 'web.lmg_status_verify_failed',
  DRY_RUN_REQUESTED: 'web.lmg_status_dry_run_requested',
  DRY_RUN_RUNNING: 'web.lmg_status_dry_run_running',
  DRY_RUN_DONE: 'web.lmg_status_dry_run_done',
  DRY_RUN_FAILED: 'web.lmg_status_dry_run_failed',
  APPROVED: 'web.lmg_status_approved',
  APPLYING: 'web.lmg_status_applying',
  COMPLETED: 'web.lmg_status_completed',
  COMPLETED_WITH_DISCREPANCY: 'web.lmg_status_completed_discrepancy',
  FAILED: 'web.lmg_status_failed',
  CANCELLED: 'web.lmg_status_cancelled',
};

const STATUS_TONES: Readonly<Record<LegacyNxpkgImportStatus, Tone>> = {
  UPLOADED: 'info',
  VERIFYING: 'info',
  VERIFIED: 'info',
  VERIFY_FAILED: 'danger',
  DRY_RUN_REQUESTED: 'info',
  DRY_RUN_RUNNING: 'info',
  DRY_RUN_DONE: 'violet',
  DRY_RUN_FAILED: 'danger',
  APPROVED: 'warn',
  APPLYING: 'warn',
  COMPLETED: 'ok',
  COMPLETED_WITH_DISCREPANCY: 'warn',
  FAILED: 'danger',
  CANCELLED: 'neutral',
};

const ERROR_LABELS: Readonly<Record<LegacyNxpkgErrorCode, WebKey>> = {
  NXPKG_CONTAINER_INVALID: 'web.lmg_error_container',
  NXPKG_WRONG_KEY: 'web.lmg_error_wrong_key',
  NXPKG_TAMPERED: 'web.lmg_error_tampered',
  NXPKG_UNSUPPORTED_VERSION: 'web.lmg_error_version',
  NXPKG_NOT_READY: 'web.lmg_error_not_ready',
  NXPKG_SOURCE_SNAPSHOT_MISSING: 'web.lmg_error_snapshot',
  NXPKG_MONEY_UNIT: 'web.lmg_error_money_unit',
  NXPKG_LIVE_FLAG: 'web.lmg_error_live_flag',
  PANEL_TARGET_MISMATCH: 'web.lmg_error_panel_target',
  FRESH_TARGET_NOT_EMPTY: 'web.lmg_error_not_fresh',
  PACKAGE_CHANGED: 'web.lmg_error_package_changed',
  DRY_RUN_MISMATCH: 'web.lmg_error_dry_run_mismatch',
  DECISIONS_INVALID: 'web.lmg_error_decisions',
  IMPORT_FAILED: 'web.lmg_error_import_failed',
  CANCELLED: 'web.lmg_error_cancelled',
  PRE_IMPORT_BACKUP_FAILED: 'web.mrz_error_pre_import_backup',
  SUPERSEDED_BY_RESTORE: 'web.mrz_error_superseded',
  APPROVAL_EXPIRED: 'web.mrz_error_approval_expired',
};

const PHASE_LABELS: Readonly<Record<LegacyMigrationPhase, WebKey>> = {
  VERIFY: 'web.lmg_phase_verify',
  DRY_RUN: 'web.lmg_phase_dry_run',
  APPLY_PRECHECK: 'web.lmg_phase_precheck',
  APPLY_IMPORT: 'web.lmg_phase_import',
  HISTORY: 'web.lmg_phase_history',
  RECONCILE: 'web.lmg_phase_reconcile',
  REPORT: 'web.lmg_phase_report',
  BACKUP: 'web.lmg_phase_backup',
};

const BACKUP_LABELS: Readonly<Record<LegacyMigrationBackupOutcome, WebKey>> = {
  TAKEN: 'web.lmg_backup_taken',
  BUSY: 'web.lmg_backup_busy',
  SKIPPED_QUIESCED: 'web.lmg_backup_quiesced',
  FAILED: 'web.lmg_backup_failed',
};

const BLOCKER_LABELS: Readonly<Record<LegacyMigrationBlocker, WebKey>> = {
  TARGET_ACK_MISSING: 'web.lmg_blocker_ack',
  CUTOVER_APPROVAL_MISSING: 'web.lmg_blocker_approval',
  STOP_SALES_NOT_ACTIVE: 'web.lmg_blocker_stop_sales',
  RECOVERY_ACTIVE: 'web.lmg_blocker_recovery',
  ANOTHER_IMPORT_APPLYING: 'web.lmg_blocker_other_import',
};

const FAULTS: Readonly<Record<string, WebKey>> = {
  'legacy_migration.disabled': 'web.lmg_disabled',
  'legacy_migration.already_active': 'web.lmg_fault_active',
  'legacy_migration.invalid_state': 'web.lmg_fault_state',
  'legacy_migration.upload_too_large': 'web.lmg_fault_too_large',
  'legacy_migration.upload_empty': 'web.lmg_fault_empty',
  'legacy_migration.digest_mismatch': 'web.lmg_fault_digest',
  'legacy_migration.confirmation_invalid': 'web.lmg_fault_phrase',
  'legacy_migration.target_ack_mismatch': 'web.mrz_fault_target_ack',
  'legacy_migration.recovery_active': 'web.mrz_fault_recovery_active',
  'legacy_migration.request_invalid': 'web.lmg_fault_request',
  'legacy_migration.not_found': 'web.lmg_fault_not_found',
  'legacy_migration.scope_stopped': 'web.lmg_fault_stopped',
};

export function legacyMigrationFault(error: unknown): string {
  if (error instanceof ApiError) {
    const key = FAULTS[error.code];
    if (key !== undefined) return t(key);
  }
  return messageFor(error);
}

// --- data ----------------------------------------------------------------------------------------

/** What the actor may do with a Mirza restore; drawn from, never trusted by, the server. */
export interface MirzaAccess {
  /** `legacy.migration.view` */
  mayView: boolean;
  /** `legacy.migration.manage` (HIGH) */
  mayManage: boolean;
  /** `legacy.migration.apply` (CRITICAL) */
  mayApply: boolean;
  /** `panels.view`: the RickPanel list the bindings choose from. */
  mayViewPanels: boolean;
}

export function mirzaAccess(permissions: readonly PermissionKey[]): MirzaAccess {
  return {
    mayView: permissions.includes('legacy.migration.view'),
    mayManage: permissions.includes('legacy.migration.manage'),
    mayApply: permissions.includes('legacy.migration.apply'),
    mayViewPanels: permissions.includes('panels.view'),
  };
}

/** The server's Mirza capabilities and the tenant's imports, polled while one is unfinished. */
export function useMirzaImports(mayView: boolean) {
  const capabilities = useQuery({
    queryKey: ['legacy-migration', 'capabilities'],
    queryFn: fetchLegacyMigrationCapabilities,
    enabled: mayView,
  });
  const enabled = capabilities.data?.enabled === true;
  const imports = useQuery({
    queryKey: ['legacy-migration', 'imports'],
    queryFn: () => fetchLegacyMigrationImports(),
    enabled: mayView && enabled,
    refetchInterval: pollUnlessFinalWhile(
      POLL_MS,
      (data: { imports: LegacyMigrationImportView[] }) =>
        data.imports.some((row) => !isLegacyNxpkgTerminalStatus(row.status)),
    ),
  });
  return {
    capabilities: capabilities.data ?? null,
    enabled,
    rows: imports.data?.imports ?? [],
  };
}

function useInvalidate(): () => void {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: ['legacy-migration'] });
}

// --- the four steps ------------------------------------------------------------------------------

const STEPS: readonly WebKey[] = [
  'web.mrz_step_upload',
  'web.mrz_step_review',
  'web.mrz_step_confirm',
  'web.mrz_step_run',
];

type StepMark = 'todo' | 'current' | 'done' | 'failed';

/** Where the import stands on the four steps: one current (or failed) step, done before it. */
export function mirzaStepMarks(row: LegacyMigrationImportView | null): readonly StepMark[] {
  const at = (current: number, failed = false): StepMark[] =>
    STEPS.map((_, index) => {
      const step = index + 1;
      if (step < current) return 'done';
      if (step === current) return failed ? 'failed' : 'current';
      return 'todo';
    });
  if (row === null) return at(1);
  switch (row.status) {
    case 'UPLOADED':
    case 'VERIFYING':
    case 'VERIFIED':
    case 'DRY_RUN_REQUESTED':
    case 'DRY_RUN_RUNNING':
      return at(2);
    case 'VERIFY_FAILED':
    case 'DRY_RUN_FAILED':
      return at(2, true);
    case 'DRY_RUN_DONE':
      return at(3);
    case 'APPROVED':
    case 'APPLYING':
      return at(4);
    case 'FAILED':
      return at(4, true);
    case 'COMPLETED':
    case 'COMPLETED_WITH_DISCREPANCY':
      return STEPS.map(() => 'done');
    case 'CANCELLED':
      return STEPS.map((_, index) => (index === 0 ? 'done' : 'todo'));
  }
}

export function MirzaSteps({ row }: { row: LegacyMigrationImportView | null }) {
  const marks = mirzaStepMarks(row);
  return (
    <ol className="recovery-steps lmg-steps" aria-label={t('web.mrz_steps_label')}>
      {STEPS.map((label, index) => {
        const mark = marks[index] ?? 'todo';
        return (
          <li
            key={label}
            className={mark}
            aria-current={mark === 'current' || mark === 'failed' ? 'step' : undefined}
          >
            <span className="recovery-step-n" aria-hidden="true">
              {mark === 'done' ? (
                <Icon name="check" size={12} />
              ) : mark === 'failed' ? (
                <Icon name="x" size={12} />
              ) : (
                <Num value={index + 1} />
              )}
            </span>
            <span>{t(label)}</span>
            {mark === 'failed' && (
              <span className="recovery-step-state">{t('web.lmg_step_failed')}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** A titled part of the flow, named for assistive technology by its own heading. */
function Step({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="stack mrz-step" aria-labelledby={id}>
      <h3 className="card-subtitle" id={id}>
        {title}
      </h3>
      {hint !== undefined && <p className="muted small">{hint}</p>}
      {children}
    </section>
  );
}

const REVIEW_STATES: readonly LegacyNxpkgImportStatus[] = [
  'UPLOADED',
  'VERIFYING',
  'VERIFIED',
  'VERIFY_FAILED',
  'DRY_RUN_REQUESTED',
  'DRY_RUN_RUNNING',
  'DRY_RUN_DONE',
  'DRY_RUN_FAILED',
];

/** The flow over ONE import, inline in the restore card. */
export function MirzaRestoreFlow({
  row,
  capabilities,
  access,
}: {
  row: LegacyMigrationImportView;
  capabilities: LegacyMigrationCapabilitiesResponse;
  access: MirzaAccess;
}) {
  const inReview = REVIEW_STATES.includes(row.status);
  const started = row.approvedAt !== null || row.status === 'APPROVED' || row.status === 'APPLYING';
  const review = (
    <div className="stack">
      <KeyStep row={row} mayManage={access.mayManage} />
      <VerifyResult row={row} />
      <ReviewSteps row={row} capabilities={capabilities} access={access} />
    </div>
  );
  return (
    <div className="stack inset mrz-flow">
      {inReview && (
        <Banner tone="warn" icon="info">
          {t('web.lmg_banner')}
        </Banner>
      )}
      <Summary row={row} mayManage={access.mayManage} />
      {/*
        The review stays readable after the confirmation — it is what was approved — but it
        folds away once the run starts, so the progress is what a phone shows first.
      */}
      {inReview ? (
        review
      ) : (
        <Disclosure variant="boxed" summary={t('web.mrz_step_review')}>
          {review}
        </Disclosure>
      )}
      {row.status === 'DRY_RUN_DONE' && row.dryRunSha256 !== null && (
        <ConfirmStep row={row} capabilities={capabilities} mayApply={access.mayApply} />
      )}
      {started && !isLegacyNxpkgTerminalStatus(row.status) && <ProgressStep row={row} />}
      {started && isLegacyNxpkgTerminalStatus(row.status) && <ResultStep row={row} />}
    </div>
  );
}

// --- the import in hand --------------------------------------------------------------------------

function Summary({ row, mayManage }: { row: LegacyMigrationImportView; mayManage: boolean }) {
  const terminal = isLegacyNxpkgTerminalStatus(row.status);
  return (
    <div className="stack">
      <KV
        items={[
          [
            t('web.lmg_status'),
            <Badge key="s" tone={STATUS_TONES[row.status]}>
              {t(STATUS_LABELS[row.status])}
            </Badge>,
          ],
          [t('web.lmg_file_name'), <Ltr key="n">{row.fileName}</Ltr>],
          [t('web.lmg_file_size'), <Num key="b" value={row.fileBytes} />],
          [t('web.lmg_file_sha256'), <Copyable key="h" value={row.fileSha256} />],
          [t('web.lmg_uploaded_at'), formatTimestamp(row.createdAt)],
        ]}
      />
      {row.errorCode !== null && (
        <Banner tone={row.errorCode === 'CANCELLED' ? 'neutral' : 'danger'}>
          {t(ERROR_LABELS[row.errorCode])} <Ltr>{row.errorCode}</Ltr>
        </Banner>
      )}
      {row.errorCode !== null &&
        row.status !== 'DRY_RUN_FAILED' &&
        row.progress.refusalCounts.length > 0 && (
          <CodeCounts title={t('web.lmg_refusal_counts')} rows={row.progress.refusalCounts} />
        )}
      {row.working && <Banner tone="info">{t('web.lmg_working')}</Banner>}
      {row.progress.blocker !== null && !terminal && (
        <Banner tone="warn">{t(BLOCKER_LABELS[row.progress.blocker])}</Banner>
      )}
      {mayManage && !terminal && <CancelButton row={row} />}
    </div>
  );
}

function CancelButton({ row }: { row: LegacyMigrationImportView }) {
  const invalidate = useInvalidate();
  const key = useSubmissionKey();
  const cancel = useMutation({
    mutationFn: () => cancelLegacyMigration(row.id, key.current({ cancel: row.id })),
    onSuccess: () => {
      key.settle();
      invalidate();
    },
    onError: (error) => key.settleOn(error, { onConflict: invalidate }),
  });
  if (!(LEGACY_MIGRATION_COMMAND_STATES.cancel as readonly string[]).includes(row.status)) {
    return <p className="muted small">{t('web.lmg_cancel_applying')}</p>;
  }
  return (
    <div className="btn-group">
      <Button variant="danger" icon="x" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
        {t('web.mrz_cancel')}
      </Button>
      {cancel.error !== null && <Banner tone="danger">{legacyMigrationFault(cancel.error)}</Banner>}
    </div>
  );
}

// --- review: the key -----------------------------------------------------------------------------

/**
 * The server erased a key left idle while the import waited on a person
 * (`LEGACY_MIGRATION_KEY_IDLE_MS`); it takes it again in these states only.
 */
function keyExpired(row: LegacyMigrationImportView): boolean {
  return (
    !row.keyPresent &&
    row.status !== 'UPLOADED' &&
    (LEGACY_MIGRATION_COMMAND_STATES.setKey as readonly string[]).includes(row.status)
  );
}

function KeyStep({ row, mayManage }: { row: LegacyMigrationImportView; mayManage: boolean }) {
  const needsKey = (row.status === 'UPLOADED' && !row.keyPresent) || keyExpired(row);
  return (
    <Step title={t('web.mrz_key_title')} hint={t('web.lmg_verify_hint')}>
      {keyExpired(row) && <Banner tone="warn">{t('web.lmg_key_expired')}</Banner>}
      {needsKey && mayManage && <KeyForm row={row} />}
      {needsKey && !mayManage && <p className="muted">{t('web.lmg_key_waiting')}</p>}
      {(row.status === 'VERIFYING' || (row.status === 'UPLOADED' && row.keyPresent)) && (
        <Banner tone="info">{t('web.lmg_verifying')}</Banner>
      )}
      {row.keyPresent && row.keyKind !== null && (
        <p className="muted small">
          {t('web.mrz_key_held')}{' '}
          {row.keyKind === 'KEY_FILE' ? t('web.lmg_key_file') : t('web.lmg_passphrase')}
        </p>
      )}
    </Step>
  );
}

function KeyForm({ row }: { row: LegacyMigrationImportView }) {
  const invalidate = useInvalidate();
  const [kind, setKind] = useState<'KEY_FILE' | 'PASSPHRASE'>('KEY_FILE');
  const [value, setValue] = useState('');
  const key = useSubmissionKey();
  const save = useMutation({
    mutationFn: () => {
      // The fingerprint names the import and the kind, never the secret.
      const idempotencyKey = key.current({ id: row.id, kind });
      return setLegacyMigrationKey(
        row.id,
        kind === 'KEY_FILE'
          ? { idempotencyKey, keyFileText: value }
          : { idempotencyKey, passphrase: value },
      );
    },
    onSuccess: () => {
      key.settle();
      setValue('');
      invalidate();
    },
    onError: (error) => key.settleOn(error, { onConflict: invalidate }),
  });
  const onKeyFile = (file: File | null): void => {
    if (file === null) return;
    void file.text().then(setValue);
  };
  return (
    <form
      className="stack"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        if (value !== '') save.mutate();
      }}
    >
      <Banner tone="info">{t('web.lmg_key_once')}</Banner>
      <Field label={t('web.lmg_key_kind')} htmlFor="lmg-key-kind">
        <Select
          id="lmg-key-kind"
          value={kind}
          onChange={(event) => {
            setKind(event.currentTarget.value === 'PASSPHRASE' ? 'PASSPHRASE' : 'KEY_FILE');
            setValue('');
          }}
        >
          <option value="KEY_FILE">{t('web.lmg_key_file')}</option>
          <option value="PASSPHRASE">{t('web.lmg_passphrase')}</option>
        </Select>
      </Field>
      {kind === 'KEY_FILE' ? (
        <>
          <Field label={t('web.lmg_key_file_choose')} htmlFor="lmg-key-file">
            <input
              id="lmg-key-file"
              type="file"
              accept=".nxkey,text/plain"
              onChange={(event) => onKeyFile(event.currentTarget.files?.[0] ?? null)}
            />
          </Field>
          <Field label={t('web.lmg_key_file_text')} htmlFor="lmg-key-text">
            <Textarea
              id="lmg-key-text"
              dir="ltr"
              rows={3}
              spellCheck={false}
              value={value}
              onChange={(event) => setValue(event.currentTarget.value)}
            />
          </Field>
        </>
      ) : (
        <Field label={t('web.lmg_passphrase')} htmlFor="lmg-passphrase">
          <Input
            id="lmg-passphrase"
            type="password"
            dir="ltr"
            autoComplete="off"
            value={value}
            onChange={(event) => setValue(event.currentTarget.value)}
          />
        </Field>
      )}
      <div className="btn-group">
        <Button
          type="submit"
          variant="primary"
          icon="lock"
          disabled={value === '' || save.isPending}
        >
          {t('web.lmg_key_save')}
        </Button>
      </div>
      {save.error !== null && <Banner tone="danger">{legacyMigrationFault(save.error)}</Banner>}
    </form>
  );
}

// --- review: what verification proved ------------------------------------------------------------

function VerifyResult({ row }: { row: LegacyMigrationImportView }) {
  const report = row.verifyReport;
  if (report === null) return null;
  return (
    <Step title={t('web.mrz_verify_title')}>
      {report.synthetic && <Banner tone="warn">{t('web.lmg_synthetic')}</Banner>}
      <KV
        items={[
          [t('web.lmg_package_id'), <Ltr key="i">{report.packageImportId}</Ltr>],
          [t('web.lmg_schema_version'), <Ltr key="v">{report.packageSchemaVersion}</Ltr>],
          [t('web.lmg_converter_version'), <Ltr key="c">{report.converterVersion}</Ltr>],
          [t('web.lmg_source_fingerprint'), <Copyable key="f" value={report.sourceFingerprint} />],
        ]}
      />
      <CodeCounts title={t('web.lmg_record_counts')} rows={report.recordCounts} />
    </Step>
  );
}

// --- review: panels, decisions and the dry run ---------------------------------------------------

/**
 * Panels, the optional decisions file and the dry run, which share one rule: the dry run is
 * requested AUTOMATICALLY once its inputs are saved (a binding or a decisions file returns the
 * import to VERIFIED and clears any earlier dry run), so the operator never has to find a
 * second button to see the report the confirmation binds.
 */
function ReviewSteps({
  row,
  capabilities,
  access,
}: {
  row: LegacyMigrationImportView;
  capabilities: LegacyMigrationCapabilitiesResponse;
  access: MirzaAccess;
}) {
  const invalidate = useInvalidate();
  const key = useSubmissionKey();
  const dryRun = useMutation({
    mutationFn: (id: string) => requestLegacyMigrationDryRun(id, key.current({ dryRun: id })),
    onSuccess: () => {
      key.settle();
      invalidate();
    },
    onError: (error) => key.settleOn(error, { onConflict: invalidate }),
  });
  const requestIfReady = (next: LegacyMigrationImportView): void => {
    if (canRequestDryRun(next, access.mayManage)) dryRun.mutate(next.id);
    else invalidate();
  };
  return (
    <>
      <PanelsStep row={row} access={access} onSaved={requestIfReady} />
      <DecisionsStep
        row={row}
        capabilities={capabilities}
        mayManage={access.mayManage}
        onSaved={requestIfReady}
      />
      <DryRunStep
        row={row}
        mayManage={access.mayManage}
        pending={dryRun.isPending}
        error={dryRun.error}
        onRequest={() => dryRun.mutate(row.id)}
      />
    </>
  );
}

function canRequestDryRun(row: LegacyMigrationImportView, mayManage: boolean): boolean {
  return (
    mayManage &&
    row.keyPresent &&
    row.panelBindings !== null &&
    row.panelBindings.length > 0 &&
    (LEGACY_MIGRATION_COMMAND_STATES.requestDryRun as readonly string[]).includes(row.status)
  );
}

function PanelsStep({
  row,
  access,
  onSaved,
}: {
  row: LegacyMigrationImportView;
  access: MirzaAccess;
  onSaved: (next: LegacyMigrationImportView) => void;
}) {
  const targets = row.verifyReport?.panelTargets ?? [];
  const editable =
    access.mayManage &&
    access.mayViewPanels &&
    (LEGACY_MIGRATION_COMMAND_STATES.setPanelBindings as readonly string[]).includes(row.status);
  const panels = useQuery({
    queryKey: ['legacy-migration', 'rickpanels'],
    queryFn: () => fetchPanels({ limit: 100 }),
    enabled: access.mayViewPanels && targets.length > 0,
  });
  // Only an ACTIVE RickPanel can receive a package's services; the server decides again, at
  // the dry run and at the apply.
  const rickpanels = (panels.data?.panels ?? []).filter(
    (panel) => panel.providerType === 'rickpanel' && panel.status === 'ACTIVE',
  );
  const nameOf = (id: string) => rickpanels.find((panel) => panel.id === id)?.name ?? id;
  const saved = Object.fromEntries((row.panelBindings ?? []).map((b) => [b.codePanel, b.panelId]));
  /*
   * Preselected when exactly ONE ACTIVE RickPanel exists — the common case of a fresh
   * installation with the one panel the operator just added. A choice the operator made, or
   * one already saved, wins; with two or more nothing is guessed.
   */
  const only = rickpanels.length === 1 ? (rickpanels[0]?.id ?? null) : null;
  const [chosen, setChosen] = useState<Readonly<Record<string, string>>>({});
  const valueOf = (code: string): string => chosen[code] ?? saved[code] ?? only ?? '';
  const bindings = targets
    .map((target) => ({ codePanel: target.codePanel, panelId: valueOf(target.codePanel) }))
    .filter((binding) => binding.panelId !== '');
  const unchanged =
    row.panelBindings !== null &&
    bindings.length === row.panelBindings.length &&
    bindings.every((binding) => saved[binding.codePanel] === binding.panelId);
  const key = useSubmissionKey();
  const save = useMutation({
    mutationFn: () =>
      setLegacyMigrationPanelBindings(row.id, {
        idempotencyKey: key.current({ id: row.id, bindings }),
        bindings,
      }),
    onSuccess: (result) => {
      key.settle();
      setChosen({});
      onSaved(result.import);
    },
    onError: (error) => key.settleOn(error),
  });
  if (targets.length === 0) {
    return (
      <Step title={t('web.mrz_panels_title')}>
        <p className="muted small">{t('web.lmg_panels_after_verify')}</p>
      </Step>
    );
  }
  const columns: readonly Column<(typeof targets)[number]>[] = [
    {
      key: 'code',
      header: t('web.lmg_col_package_panel'),
      render: (target) => <Ltr>{target.codePanel}</Ltr>,
    },
    {
      key: 'services',
      header: t('web.lmg_col_services'),
      render: (target) => <Num value={target.services} />,
    },
    {
      key: 'panel',
      header: t('web.lmg_col_nexa_panel'),
      render: (target) =>
        editable ? (
          <Select
            aria-label={`${t('web.lmg_col_nexa_panel')} ${target.codePanel}`}
            value={valueOf(target.codePanel)}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setChosen((before) => ({ ...before, [target.codePanel]: value }));
            }}
          >
            <option value="">{t('web.lmg_choose_panel')}</option>
            {rickpanels.map((panel) => (
              <option key={panel.id} value={panel.id}>
                {panel.name}
              </option>
            ))}
          </Select>
        ) : saved[target.codePanel] !== undefined ? (
          <span>{nameOf(saved[target.codePanel] ?? '')}</span>
        ) : (
          <span className="muted">—</span>
        ),
    },
  ];
  return (
    <Step title={t('web.mrz_panels_title')} hint={t('web.lmg_panels_hint')}>
      {!access.mayViewPanels && <Banner tone="neutral">{t('web.lmg_panels_need_view')}</Banner>}
      {editable && panels.isSuccess && rickpanels.length === 0 && (
        <Banner tone="warn">{t('web.lmg_no_rickpanel')}</Banner>
      )}
      {editable && only !== null && row.panelBindings === null && (
        <p className="muted small">{t('web.mrz_panels_preselected')}</p>
      )}
      <DataTable
        columns={columns}
        rows={targets}
        rowKey={(target) => target.codePanel}
        caption={t('web.mrz_panels_title')}
        dense
      />
      {editable && !unchanged && (
        <div className="btn-group">
          <Button
            variant="primary"
            disabled={bindings.length !== targets.length || save.isPending}
            onClick={() => save.mutate()}
          >
            {t('web.mrz_panels_save')}
          </Button>
          {row.status === 'DRY_RUN_DONE' && (
            <span className="muted small">{t('web.lmg_panels_resets_dry_run')}</span>
          )}
        </div>
      )}
      {save.error !== null && <Banner tone="danger">{legacyMigrationFault(save.error)}</Banner>}
    </Step>
  );
}

function DecisionsStep({
  row,
  capabilities,
  mayManage,
  onSaved,
}: {
  row: LegacyMigrationImportView;
  capabilities: LegacyMigrationCapabilitiesResponse;
  mayManage: boolean;
  onSaved: (next: LegacyMigrationImportView) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const tooLarge = file !== null && file.size > capabilities.maxDecisionsBytes;
  const upload = useMutation({
    mutationFn: (chosen: File) => uploadLegacyMigrationDecisions(row.id, chosen),
    onSuccess: (result) => {
      setFile(null);
      onSaved(result.import);
    },
  });
  const open =
    mayManage &&
    (LEGACY_MIGRATION_COMMAND_STATES.uploadDecisions as readonly string[]).includes(row.status);
  if (!open && !row.decisionsPresent) return null;
  return (
    <Step title={t('web.mrz_decisions_title')}>
      <p className="muted small">
        {row.decisionsPresent ? t('web.lmg_decisions_present') : t('web.lmg_decisions_absent')}
      </p>
      {open && (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (file !== null && !tooLarge) upload.mutate(file);
          }}
        >
          <Field label={t('web.lmg_decisions_choose')} htmlFor="lmg-decisions">
            <input
              id="lmg-decisions"
              type="file"
              accept=".json,application/json"
              onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
            />
          </Field>
          {tooLarge && <Banner tone="danger">{t('web.lmg_fault_too_large')}</Banner>}
          <div className="btn-group">
            <Button
              type="submit"
              icon="upload"
              disabled={file === null || tooLarge || upload.isPending}
            >
              {t('web.lmg_decisions_send')}
            </Button>
          </div>
          {upload.error !== null && (
            <Banner tone="danger">{legacyMigrationFault(upload.error)}</Banner>
          )}
        </form>
      )}
    </Step>
  );
}

function DryRunStep({
  row,
  mayManage,
  pending,
  error,
  onRequest,
}: {
  row: LegacyMigrationImportView;
  mayManage: boolean;
  pending: boolean;
  error: unknown;
  onRequest: () => void;
}) {
  const report = row.dryRunReport;
  const waiting = pending || row.status === 'DRY_RUN_REQUESTED' || row.status === 'DRY_RUN_RUNNING';
  // Offered by hand only when the automatic request did not happen (a reload, a refusal).
  const offer = canRequestDryRun(row, mayManage) && row.status === 'VERIFIED' && !pending;
  return (
    <Step title={t('web.mrz_dry_run_title')} hint={t('web.lmg_dry_run_hint')}>
      {waiting && <Banner tone="info">{t('web.lmg_dry_run_running')}</Banner>}
      {row.status === 'DRY_RUN_FAILED' && row.progress.refusalCounts.length > 0 && (
        <CodeCounts title={t('web.lmg_refusal_counts')} rows={row.progress.refusalCounts} />
      )}
      {report === null && !waiting && row.status !== 'DRY_RUN_FAILED' && (
        <p className="muted small">{t('web.mrz_dry_run_after_inputs')}</p>
      )}
      {report !== null && (
        <>
          <KV
            items={[
              [t('web.lmg_importer_verdict'), <Ltr key="v">{report.importerVerdict}</Ltr>],
              [
                t('web.lmg_dry_run_digest'),
                row.dryRunSha256 === null ? '—' : <Copyable key="d" value={row.dryRunSha256} />,
              ],
              [t('web.lmg_customers'), <Num key="c" value={report.wallets.customers} />],
            ]}
          />
          <SectionTable rows={report.sections} />
          <h4 className="card-subtitle">{t('web.mrz_money_title')}</h4>
          <KV
            items={[
              [
                t('web.lmg_wallet_before'),
                <Amount
                  key="b"
                  minor={report.wallets.beforeTotalMinor}
                  currency={report.wallets.currency}
                />,
              ],
              [
                t('web.lmg_wallet_after'),
                <Amount
                  key="a"
                  minor={report.wallets.afterTotalMinor}
                  currency={report.wallets.currency}
                />,
              ],
              [t('web.lmg_wallet_customers'), <Num key="c" value={report.wallets.customers} />],
              [t('web.lmg_debts_count'), <Num key="d" value={report.debts.count} />],
              [
                t('web.lmg_debts_total'),
                <Amount key="t" minor={report.debts.totalMinor} currency={report.debts.currency} />,
              ],
            ]}
          />
          <p className="muted small">{t('web.lmg_debts_never_collected')}</p>
          <h4 className="card-subtitle">{t('web.lmg_ownership_title')}</h4>
          <KV
            items={[
              [
                t('web.lmg_ownership_decisions'),
                report.ownership.decisionsProvided ? t('web.lmg_yes') : t('web.lmg_no'),
              ],
              [t('web.lmg_ownership_proven'), <Num key="p" value={report.ownership.proven} />],
              [
                t('web.lmg_ownership_unverified'),
                <Num key="u" value={report.ownership.adminApprovedUnverified} />,
              ],
              [
                t('web.lmg_ownership_quarantined'),
                <Num key="q" value={report.ownership.quarantined} />,
              ],
              [t('web.lmg_ownership_rejected'), <Num key="r" value={report.ownership.rejected} />],
              [t('web.lmg_ownership_pending'), <Num key="n" value={report.ownership.pending} />],
              [t('web.lmg_ownership_stale'), <Num key="s" value={report.ownership.stale} />],
            ]}
          />
          <CodeCounts title={t('web.lmg_quarantine')} rows={report.quarantine} />
          <CodeCounts title={t('web.lmg_warnings')} rows={report.warnings} />
        </>
      )}
      {offer && (
        <div className="btn-group">
          <Button variant="primary" icon="play" onClick={onRequest}>
            {t('web.lmg_dry_run_request')}
          </Button>
        </div>
      )}
      {error !== null && error !== undefined && (
        <Banner tone="danger">{legacyMigrationFault(error)}</Banner>
      )}
    </Step>
  );
}

/** Minor units as stored, with the currency named: never converted, never rounded here. */
function Amount({ minor, currency }: { minor: string; currency: string }) {
  return (
    <span>
      <Num value={minor} /> <Ltr mono={false}>{currency}</Ltr>
    </span>
  );
}

// --- confirm -------------------------------------------------------------------------------------

/**
 * The one confirmation. It carries the dry run digest shown here, the typed phrase and the
 * installation's target acknowledgement (the capabilities' digest of this database and tenant,
 * null on a target that is not production-like). The same call records the owner's cutover
 * approval and stop-sales is held by the import's own write freeze, so the operator is never
 * sent to another page, a server command or an environment variable.
 */
function ConfirmStep({
  row,
  capabilities,
  mayApply,
}: {
  row: LegacyMigrationImportView;
  capabilities: LegacyMigrationCapabilitiesResponse;
  mayApply: boolean;
}) {
  const invalidate = useInvalidate();
  const [phrase, setPhrase] = useState('');
  const key = useSubmissionKey();
  const digest = row.dryRunSha256 ?? '';
  const approve = useMutation({
    mutationFn: () => {
      const body = {
        dryRunSha256: digest,
        confirmation: phrase,
        targetAcknowledgement: capabilities.targetAcknowledgement,
      };
      return approveLegacyMigration(row.id, {
        ...body,
        idempotencyKey: key.current({ id: row.id, ...body }),
      });
    },
    onSuccess: () => {
      key.settle();
      setPhrase('');
      invalidate();
    },
    onError: (error) => key.settleOn(error, { onConflict: invalidate }),
  });
  const matches = phrase === capabilities.approvalPhrase;
  return (
    <Step title={t('web.mrz_step_confirm')}>
      <KV
        items={[
          [
            t('web.mrz_target'),
            <span key="t">
              {t('web.mrz_target_this')}{' '}
              {capabilities.productionLikeTarget && (
                <Badge tone="warn">{t('web.mrz_target_production_like')}</Badge>
              )}
            </span>,
          ],
          ...(capabilities.targetAcknowledgement === null
            ? []
            : ([
                [
                  t('web.mrz_target_ack'),
                  <Copyable key="a" value={capabilities.targetAcknowledgement} />,
                ],
              ] as [ReactNode, ReactNode][])),
          [t('web.lmg_dry_run_digest'), <Copyable key="d" value={digest} />],
        ]}
      />
      <Banner tone="warn" title={t('web.mrz_protective_title')}>
        {t('web.mrz_protective_body')}
      </Banner>
      {!mayApply ? (
        <Banner tone="neutral">{t('web.lmg_approval_owner_only')}</Banner>
      ) : (
        <form
          className="stack inset danger-zone"
          onSubmit={(event) => {
            event.preventDefault();
            if (matches) approve.mutate();
          }}
        >
          <Banner tone="danger">{t('web.lmg_approval_warning')}</Banner>
          <Field
            label={t('web.lmg_approval_phrase').replace('{phrase}', capabilities.approvalPhrase)}
            htmlFor="mrz-phrase"
          >
            <Input
              id="mrz-phrase"
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              className="recovery-phrase"
              value={phrase}
              onChange={(event) => setPhrase(event.currentTarget.value)}
            />
          </Field>
          {phrase !== '' && !matches && (
            <Banner tone="warn">{t('web.recovery_confirm_wrong')}</Banner>
          )}
          <div className="btn-group">
            <Button type="submit" variant="danger-solid" disabled={!matches || approve.isPending}>
              {t('web.mrz_confirm_button')}
            </Button>
          </div>
          {approve.error !== null && (
            <Banner tone="danger">{legacyMigrationFault(approve.error)}</Banner>
          )}
        </form>
      )}
    </Step>
  );
}

// --- run and result ------------------------------------------------------------------------------

const RUN_STAGES: readonly WebKey[] = [
  'web.mrz_run_protective',
  'web.mrz_run_import',
  'web.mrz_run_reconcile',
  'web.mrz_run_report',
  'web.mrz_run_backup',
];

const PHASE_STAGE: Readonly<Record<LegacyMigrationPhase, number>> = {
  VERIFY: 0,
  DRY_RUN: 0,
  APPLY_PRECHECK: 1,
  APPLY_IMPORT: 1,
  HISTORY: 1,
  RECONCILE: 2,
  REPORT: 3,
  BACKUP: 4,
};

/**
 * Which of the five run stages is under way. The protective backup is done exactly when the
 * row names its run; before that nothing else can have started (the server takes it before
 * any write).
 */
export function runStage(row: LegacyMigrationImportView): number {
  if (row.preImportBackupRunId === null) return 0;
  const phase = row.progress.phase;
  return Math.max(1, phase === null ? 1 : PHASE_STAGE[phase]);
}

function ProgressStep({ row }: { row: LegacyMigrationImportView }) {
  const current = runStage(row);
  return (
    <Step title={t('web.mrz_step_run')}>
      <Banner tone="info">{t('web.mrz_run_frozen')}</Banner>
      <ol className="mrz-progress" aria-label={t('web.mrz_step_run')}>
        {RUN_STAGES.map((label, index) => {
          const mark = index < current ? 'done' : index === current ? 'current' : 'todo';
          return (
            <li key={label} className={mark} aria-current={mark === 'current' ? 'step' : undefined}>
              <span className="mrz-progress-mark" aria-hidden="true">
                {mark === 'done' ? <Icon name="check" size={12} /> : <Num value={index + 1} />}
              </span>
              <span>{t(label)}</span>
              {mark === 'current' && (
                <span className="muted small">{t('web.mrz_run_in_progress')}</span>
              )}
            </li>
          );
        })}
      </ol>
      <KV
        items={[
          [
            t('web.mrz_protective_run'),
            row.preImportBackupRunId === null ? (
              '—'
            ) : (
              <Copyable key="p" value={row.preImportBackupRunId} />
            ),
          ],
          [
            t('web.lmg_phase'),
            row.progress.phase === null ? '—' : t(PHASE_LABELS[row.progress.phase]),
          ],
          [t('web.lmg_apply_attempts'), <Num key="a" value={row.progress.applyAttempts} />],
        ]}
      />
      {row.status === 'APPLYING' && row.progress.applyAttempts > 1 && (
        <Banner tone="info">{t('web.lmg_resumed')}</Banner>
      )}
    </Step>
  );
}

function ResultStep({ row }: { row: LegacyMigrationImportView }) {
  const onLink = useLinkHandler();
  const report = row.applyReport;
  const completed = row.status === 'COMPLETED' || row.status === 'COMPLETED_WITH_DISCREPANCY';
  const clean = row.status === 'COMPLETED' && report?.reconcileVerdict === 'RECONCILED';
  return (
    <Step title={t('web.mrz_result_title')}>
      {completed && clean && <Banner tone="ok">{t('web.mrz_result_ok')}</Banner>}
      {completed && !clean && <Banner tone="warn">{t('web.lmg_report_discrepancy')}</Banner>}
      {row.status === 'FAILED' && <Banner tone="danger">{t('web.mrz_result_failed')}</Banner>}
      <KV
        items={[
          [
            t('web.mrz_protective_run'),
            row.preImportBackupRunId === null ? (
              '—'
            ) : (
              <Copyable key="p" value={row.preImportBackupRunId} />
            ),
          ],
          ...(report === null
            ? []
            : ([
                [t('web.lmg_importer_verdict'), <Ltr key="i">{report.importerVerdict}</Ltr>],
                [
                  t('web.lmg_reconcile_verdict'),
                  report.reconcileVerdict === 'RECONCILED'
                    ? t('web.lmg_reconciled')
                    : t('web.lmg_discrepancy'),
                ],
                [
                  t('web.lmg_report_holds'),
                  report.reportHolds ? t('web.lmg_yes') : t('web.lmg_no'),
                ],
                [
                  t('web.lmg_failed_invariants'),
                  report.failedInvariants.length === 0 ? (
                    '—'
                  ) : (
                    <Ltr key="f">{report.failedInvariants.join(', ')}</Ltr>
                  ),
                ],
                [
                  t('web.lmg_failed_sections'),
                  report.failedSections.length === 0 ? (
                    '—'
                  ) : (
                    <Ltr key="s">{report.failedSections.join(', ')}</Ltr>
                  ),
                ],
              ] as [ReactNode, ReactNode][])),
          [
            t('web.lmg_backup'),
            row.progress.backup === null ? '—' : t(BACKUP_LABELS[row.progress.backup]),
          ],
          [
            t('web.lmg_backup_run'),
            row.backupRunId === null ? '—' : <Ltr key="b">{row.backupRunId}</Ltr>,
          ],
        ]}
      />
      {row.preImportBackupRunId !== null && <p className="muted small">{t('web.mrz_undo_hint')}</p>}
      {report !== null && (
        <>
          <SectionTable rows={report.sections} />
          <CodeCounts title={t('web.lmg_history')} rows={report.history} />
        </>
      )}
      <p className="small">
        <a className="link" href="/audit-log" onClick={onLink}>
          {t('web.lmg_audit_link')}
        </a>
      </p>
    </Step>
  );
}

// --- shared pieces -------------------------------------------------------------------------------

/** Per-section counts, `table:` and `history:` sections included, exactly as reported. */
export function SectionTable({ rows }: { rows: readonly LegacyMigrationSectionCounts[] }) {
  if (rows.length === 0) return null;
  const count = (
    key: keyof Omit<LegacyMigrationSectionCounts, 'section'>,
    header: WebKey,
  ): Column<LegacyMigrationSectionCounts> => ({
    key,
    header: t(header),
    align: 'end',
    render: (row) => <Num value={row[key]} />,
  });
  return (
    <DataTable
      columns={[
        {
          key: 'section',
          header: t('web.lmg_col_section'),
          render: (row) => <Ltr>{row.section}</Ltr>,
        },
        count('source', 'web.lmg_col_source'),
        count('imported', 'web.lmg_col_imported'),
        count('archived', 'web.lmg_col_archived'),
        count('skipped', 'web.lmg_col_skipped'),
        count('quarantined', 'web.lmg_col_quarantined'),
      ]}
      rows={rows}
      rowKey={(row) => row.section}
      caption={t('web.lmg_sections')}
      dense
    />
  );
}

function CodeCounts({ title, rows }: { title: string; rows: readonly LegacyMigrationCodeCount[] }) {
  return (
    <div className="stack">
      <h4 className="card-subtitle">{title}</h4>
      {rows.length === 0 ? (
        <p className="muted small">{t('web.lmg_none')}</p>
      ) : (
        <KV
          items={rows.map((row) => [
            <Ltr key={row.code}>{row.code}</Ltr>,
            <Num key="n" value={row.count} />,
          ])}
        />
      )}
    </div>
  );
}

/** Earlier Mirza restores, newest first, with the protective backup each one took. */
export function MirzaHistory({ rows }: { rows: readonly LegacyMigrationImportView[] }) {
  if (rows.length === 0) return null;
  const columns: readonly Column<LegacyMigrationImportView>[] = [
    { key: 'file', header: t('web.lmg_file_name'), render: (row) => <Ltr>{row.fileName}</Ltr> },
    {
      key: 'status',
      header: t('web.lmg_status'),
      render: (row) => (
        <Badge tone={STATUS_TONES[row.status]}>{t(STATUS_LABELS[row.status])}</Badge>
      ),
    },
    {
      key: 'error',
      header: t('web.lmg_col_error'),
      render: (row): ReactNode => (row.errorCode === null ? '—' : t(ERROR_LABELS[row.errorCode])),
    },
    {
      key: 'protective',
      header: t('web.mrz_protective_run'),
      render: (row): ReactNode =>
        row.preImportBackupRunId === null ? '—' : <Ltr>{row.preImportBackupRunId}</Ltr>,
    },
    {
      key: 'at',
      header: t('web.lmg_uploaded_at'),
      render: (row) => formatTimestamp(row.createdAt),
    },
  ];
  return (
    <div className="stack">
      <h3 className="card-subtitle">{t('web.lmg_history_title')}</h3>
      <DataTable
        columns={columns}
        rows={[...rows]}
        rowKey={(row) => row.id}
        caption={t('web.lmg_history_title')}
        dense
      />
    </div>
  );
}
