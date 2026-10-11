import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
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
  uploadLegacyMigrationPackage,
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
  Card,
  Copyable,
  DataTable,
  Empty,
  Field,
  Input,
  KV,
  Ltr,
  Num,
  PageHead,
  Select,
  StateSwitch,
  Textarea,
  type Column,
  type Tone,
} from '../ui/kit';
import { Icon } from '../ui/icons';

/**
 * Mirza `.nxpkg` importer — «مهاجرت از میرزا» (`docs/legacy-migration/nxpkg-importer.md` §8).
 *
 * Eight steps over ONE import row: upload · verify · dry run · panels and customers · money
 * and ownership · final approval · import · report. Nothing on this page opens a package:
 * every step that does is the server's `migration` process role, and this page polls the row
 * while it works. The key is write-only (the page is told only that one is held); no path,
 * no legacy row and no personal data is ever shown — counts, codes and digests.
 *
 * Permissions: `legacy.migration.view` to see it, `legacy.migration.manage` to upload, give
 * the key, bind the panels and request a dry run, the CRITICAL `legacy.migration.apply` to
 * approve. A control the actor may not use is not offered; the server refuses it anyway.
 */

const POLL_MS = 5_000;

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
};

/** The seven values a cutover approval binds, in `/legacy-cutover`'s order. */
const CUTOVER_FIELDS = [
  ['sourceFingerprint', 'web.lco_field_source'],
  ['panelMapFingerprint', 'web.lco_field_panel_map'],
  ['inventoryFingerprint', 'web.lco_field_inventory'],
  ['productsFingerprint', 'web.lco_field_products'],
  ['invoiceArchiveFingerprint', 'web.lco_field_invoice_archive'],
  ['freezeProofSha256', 'web.lco_field_freeze'],
  ['finalDumpSha256', 'web.lco_field_dump'],
] as const satisfies readonly (readonly [string, WebKey])[];

const FAULTS: Readonly<Record<string, WebKey>> = {
  'legacy_migration.disabled': 'web.lmg_disabled',
  'legacy_migration.already_active': 'web.lmg_fault_active',
  'legacy_migration.invalid_state': 'web.lmg_fault_state',
  'legacy_migration.upload_too_large': 'web.lmg_fault_too_large',
  'legacy_migration.upload_empty': 'web.lmg_fault_empty',
  'legacy_migration.digest_mismatch': 'web.lmg_fault_digest',
  'legacy_migration.confirmation_invalid': 'web.lmg_fault_phrase',
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

const STEPS: readonly WebKey[] = [
  'web.lmg_step_upload',
  'web.lmg_step_verify',
  'web.lmg_step_dry_run',
  'web.lmg_step_panels',
  'web.lmg_step_money',
  'web.lmg_step_approval',
  'web.lmg_step_import',
  'web.lmg_step_report',
];

type StepMark = 'todo' | 'current' | 'done' | 'failed';

/** Where the import stands on the eight steps: one current (or failed) step, done before it. */
export function stepMarks(row: LegacyMigrationImportView | null): readonly StepMark[] {
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
      return at(2);
    case 'VERIFY_FAILED':
      return at(2, true);
    case 'VERIFIED':
    case 'DRY_RUN_REQUESTED':
    case 'DRY_RUN_RUNNING':
      return at(3);
    case 'DRY_RUN_FAILED':
      return at(3, true);
    case 'DRY_RUN_DONE':
      return at(6);
    case 'APPROVED':
    case 'APPLYING':
      return at(7);
    case 'FAILED':
      return at(7, true);
    case 'COMPLETED':
    case 'COMPLETED_WITH_DISCREPANCY':
      return STEPS.map(() => 'done');
    case 'CANCELLED':
      return at(1).map((mark, index) =>
        index === 0 ? 'done' : mark === 'current' ? 'todo' : mark,
      );
  }
}

function Stepper({ row }: { row: LegacyMigrationImportView | null }) {
  const marks = stepMarks(row);
  return (
    <ol className="recovery-steps lmg-steps" aria-label={t('web.lmg_steps_label')}>
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

export function LegacyMigrationPage({
  denied,
  mayManage,
  mayApply,
  mayViewPanels,
}: {
  /** `legacy.migration.view` is not held. */
  denied: boolean;
  /** `legacy.migration.manage` (HIGH). */
  mayManage: boolean;
  /** `legacy.migration.apply` (CRITICAL). */
  mayApply: boolean;
  /** `panels.view`: the RickPanel list the bindings choose from. */
  mayViewPanels: boolean;
}) {
  const capabilities = useQuery({
    queryKey: ['legacy-migration', 'capabilities'],
    queryFn: fetchLegacyMigrationCapabilities,
    enabled: !denied,
  });
  const enabled = capabilities.data?.enabled === true;
  const imports = useQuery({
    queryKey: ['legacy-migration', 'imports'],
    queryFn: () => fetchLegacyMigrationImports(),
    enabled: !denied && enabled,
    refetchInterval: pollUnlessFinalWhile(
      POLL_MS,
      (data: { imports: LegacyMigrationImportView[] }) =>
        data.imports.some((row) => !isLegacyNxpkgTerminalStatus(row.status)),
    ),
  });
  const rows = imports.data?.imports ?? [];
  const current = rows[0] ?? null;
  const active = current !== null && !isLegacyNxpkgTerminalStatus(current.status);

  return (
    <>
      <PageHead title={t('web.lmg_title')} subtitle={t('web.lmg_subtitle')} />
      <Banner tone="warn" icon="info">
        {t('web.lmg_banner')}
      </Banner>
      <StateSwitch query={capabilities} denied={denied}>
        {capabilities.data !== undefined && !enabled ? (
          <Banner tone="neutral">{t('web.lmg_disabled')}</Banner>
        ) : (
          capabilities.data !== undefined && (
            <StateSwitch query={imports}>
              <div className="stack lmg-page">
                <Stepper row={current} />
                {!active && mayManage && <UploadCard capabilities={capabilities.data} />}
                {!active && !mayManage && current === null && (
                  <Empty title={t('web.lmg_empty')} hint={t('web.lmg_empty_hint')} />
                )}
                {current !== null && (
                  <ImportFlow
                    row={current}
                    capabilities={capabilities.data}
                    mayManage={mayManage}
                    mayApply={mayApply}
                    mayViewPanels={mayViewPanels}
                  />
                )}
                {rows.length > 1 && <History rows={rows.slice(1)} />}
              </div>
            </StateSwitch>
          )
        )}
      </StateSwitch>
    </>
  );
}

// --- step 1: upload ----------------------------------------------------------------------------

function UploadCard({ capabilities }: { capabilities: LegacyMigrationCapabilitiesResponse }) {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const tooLarge = file !== null && file.size > capabilities.maxUploadBytes;
  const upload = useMutation({
    mutationFn: (chosen: File) => uploadLegacyMigrationPackage(chosen),
    onSuccess: () => {
      setFile(null);
      void queryClient.invalidateQueries({ queryKey: ['legacy-migration'] });
    },
  });
  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (file !== null && !tooLarge) upload.mutate(file);
  };
  return (
    <Card title={stepTitle(1)} hint={t('web.lmg_upload_hint')}>
      <form className="stack" onSubmit={onSubmit}>
        <Field label={t('web.lmg_upload_choose')} htmlFor="lmg-package">
          <input
            id="lmg-package"
            type="file"
            accept=".nxpkg,application/octet-stream"
            className="recovery-file"
            onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
          />
        </Field>
        {tooLarge && <Banner tone="danger">{t('web.lmg_fault_too_large')}</Banner>}
        <div className="btn-group">
          <Button
            type="submit"
            variant="primary"
            icon="upload"
            disabled={file === null || tooLarge || upload.isPending}
          >
            {upload.isPending ? t('web.lmg_uploading') : t('web.lmg_upload_send')}
          </Button>
        </div>
        {upload.error !== null && (
          <Banner tone="danger">{legacyMigrationFault(upload.error)}</Banner>
        )}
      </form>
    </Card>
  );
}

// --- the flow over one import ------------------------------------------------------------------

function ImportFlow({
  row,
  capabilities,
  mayManage,
  mayApply,
  mayViewPanels,
}: {
  row: LegacyMigrationImportView;
  capabilities: LegacyMigrationCapabilitiesResponse;
  mayManage: boolean;
  mayApply: boolean;
  mayViewPanels: boolean;
}) {
  const terminal = isLegacyNxpkgTerminalStatus(row.status);
  return (
    <>
      <Card
        title={stepTitle(1)}
        actions={<Badge tone={STATUS_TONES[row.status]}>{t(STATUS_LABELS[row.status])}</Badge>}
      >
        <KV
          items={[
            [t('web.lmg_file_name'), <Ltr key="n">{row.fileName}</Ltr>],
            [t('web.lmg_file_size'), <Num key="b" value={row.fileBytes} />],
            [t('web.lmg_file_sha256'), <Copyable key="s" value={row.fileSha256} />],
            [t('web.lmg_uploaded_at'), formatTimestamp(row.createdAt)],
          ]}
        />
        {row.errorCode !== null && (
          <Banner tone={row.errorCode === 'CANCELLED' ? 'neutral' : 'danger'}>
            {t(ERROR_LABELS[row.errorCode])}
          </Banner>
        )}
        {row.errorCode !== null &&
          row.status !== 'DRY_RUN_FAILED' &&
          row.progress.refusalCounts.length > 0 && (
            <CodeCounts title={t('web.lmg_refusal_counts')} rows={row.progress.refusalCounts} />
          )}
        {row.working && <Banner tone="info">{t('web.lmg_working')}</Banner>}
        {row.progress.blocker !== null && !terminal && (
          <ProductionGate row={row} capabilities={capabilities} />
        )}
        {mayManage && !terminal && <CancelButton row={row} />}
      </Card>
      <VerifyCard row={row} mayManage={mayManage} />
      <DryRunCard row={row} mayManage={mayManage} />
      <PanelsCard row={row} mayManage={mayManage} mayViewPanels={mayViewPanels} />
      <MoneyCard row={row} capabilities={capabilities} mayManage={mayManage} />
      <ApprovalCard row={row} capabilities={capabilities} mayApply={mayApply} />
      <ImportCard row={row} />
      <ReportCard row={row} />
    </>
  );
}

function stepTitle(step: number): string {
  return `${t('web.lmg_step_n').replace('{n}', new Intl.NumberFormat('fa-IR').format(step))} — ${t(
    STEPS[step - 1] ?? 'web.lmg_step_upload',
  )}`;
}

function useInvalidate(): () => void {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: ['legacy-migration'] });
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
        {t('web.lmg_cancel')}
      </Button>
      {cancel.error !== null && <Banner tone="danger">{legacyMigrationFault(cancel.error)}</Banner>}
    </div>
  );
}

// --- step 2: verify (and the key) ------------------------------------------------------------

function VerifyCard({ row, mayManage }: { row: LegacyMigrationImportView; mayManage: boolean }) {
  const report = row.verifyReport;
  return (
    <Card title={stepTitle(2)} hint={t('web.lmg_verify_hint')}>
      {row.status === 'UPLOADED' && !row.keyPresent && mayManage && <KeyForm row={row} />}
      {keyExpired(row) && <Banner tone="warn">{t('web.lmg_key_expired')}</Banner>}
      {keyExpired(row) && mayManage && <KeyForm row={row} />}
      {row.status === 'UPLOADED' && !row.keyPresent && !mayManage && (
        <p className="muted">{t('web.lmg_key_waiting')}</p>
      )}
      {(row.status === 'VERIFYING' || (row.status === 'UPLOADED' && row.keyPresent)) && (
        <Banner tone="info">{t('web.lmg_verifying')}</Banner>
      )}
      {report !== null && (
        <>
          {report.synthetic && <Banner tone="warn">{t('web.lmg_synthetic')}</Banner>}
          <KV
            items={[
              [t('web.lmg_package_id'), <Ltr key="i">{report.packageImportId}</Ltr>],
              [t('web.lmg_schema_version'), <Ltr key="v">{report.packageSchemaVersion}</Ltr>],
              [t('web.lmg_converter_version'), <Ltr key="c">{report.converterVersion}</Ltr>],
              [
                t('web.lmg_source_fingerprint'),
                <Copyable key="f" value={report.sourceFingerprint} />,
              ],
              [
                t('web.lmg_key_kind'),
                row.keyKind === 'KEY_FILE' ? t('web.lmg_key_file') : t('web.lmg_passphrase'),
              ],
            ]}
          />
          <CodeCounts title={t('web.lmg_record_counts')} rows={report.recordCounts} />
        </>
      )}
    </Card>
  );
}

/**
 * The `migration` role erased a key left idle while the import waited on a person
 * (`LEGACY_MIGRATION_KEY_IDLE_MS`); the server takes it again in these states only.
 */
function keyExpired(row: LegacyMigrationImportView): boolean {
  return (
    !row.keyPresent &&
    row.status !== 'UPLOADED' &&
    (LEGACY_MIGRATION_COMMAND_STATES.setKey as readonly string[]).includes(row.status)
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

// --- step 3: the dry run ------------------------------------------------------------------------

function DryRunCard({ row, mayManage }: { row: LegacyMigrationImportView; mayManage: boolean }) {
  const invalidate = useInvalidate();
  const key = useSubmissionKey();
  const request = useMutation({
    mutationFn: () => requestLegacyMigrationDryRun(row.id, key.current({ dryRun: row.id })),
    onSuccess: () => {
      key.settle();
      invalidate();
    },
    onError: (error) => key.settleOn(error, { onConflict: invalidate }),
  });
  const canRequest =
    mayManage &&
    row.keyPresent &&
    (LEGACY_MIGRATION_COMMAND_STATES.requestDryRun as readonly string[]).includes(row.status);
  const bound = row.panelBindings !== null && row.panelBindings.length > 0;
  const report = row.dryRunReport;
  return (
    <Card title={stepTitle(3)} hint={t('web.lmg_dry_run_hint')}>
      {(row.status === 'DRY_RUN_REQUESTED' || row.status === 'DRY_RUN_RUNNING') && (
        <Banner tone="info">{t('web.lmg_dry_run_running')}</Banner>
      )}
      {row.status === 'DRY_RUN_FAILED' && row.progress.refusalCounts.length > 0 && (
        <CodeCounts title={t('web.lmg_refusal_counts')} rows={row.progress.refusalCounts} />
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
            ]}
          />
          <SectionTable rows={report.sections} />
          <CodeCounts title={t('web.lmg_warnings')} rows={report.warnings} />
          <CodeCounts title={t('web.lmg_quarantine')} rows={report.quarantine} />
        </>
      )}
      {canRequest && (
        <div className="stack">
          {!bound && <p className="muted small">{t('web.lmg_dry_run_needs_panels')}</p>}
          <div className="btn-group">
            <Button
              variant="primary"
              icon="play"
              disabled={!bound || request.isPending}
              onClick={() => request.mutate()}
            >
              {row.status === 'DRY_RUN_DONE'
                ? t('web.lmg_dry_run_again')
                : t('web.lmg_dry_run_request')}
            </Button>
          </div>
          {request.error !== null && (
            <Banner tone="danger">{legacyMigrationFault(request.error)}</Banner>
          )}
        </div>
      )}
    </Card>
  );
}

// --- step 4: panels and customers ---------------------------------------------------------------

function PanelsCard({
  row,
  mayManage,
  mayViewPanels,
}: {
  row: LegacyMigrationImportView;
  mayManage: boolean;
  mayViewPanels: boolean;
}) {
  const invalidate = useInvalidate();
  const targets = row.verifyReport?.panelTargets ?? [];
  const editable =
    mayManage &&
    mayViewPanels &&
    (LEGACY_MIGRATION_COMMAND_STATES.setPanelBindings as readonly string[]).includes(row.status);
  const panels = useQuery({
    queryKey: ['legacy-migration', 'rickpanels'],
    queryFn: () => fetchPanels({ limit: 100 }),
    enabled: mayViewPanels && targets.length > 0,
  });
  // Only an ACTIVE RickPanel can receive a package's services (design §1); the server decides
  // again, at the dry run and at the apply.
  const rickpanels = (panels.data?.panels ?? []).filter(
    (panel) => panel.providerType === 'rickpanel' && panel.status === 'ACTIVE',
  );
  const nameOf = (id: string) => rickpanels.find((panel) => panel.id === id)?.name ?? id;
  const initial = Object.fromEntries(
    (row.panelBindings ?? []).map((b) => [b.codePanel, b.panelId]),
  );
  const [chosen, setChosen] = useState<Readonly<Record<string, string>>>(initial);
  const key = useSubmissionKey();
  const bindings = targets
    .map((target) => ({ codePanel: target.codePanel, panelId: chosen[target.codePanel] ?? '' }))
    .filter((binding) => binding.panelId !== '');
  const save = useMutation({
    mutationFn: () =>
      setLegacyMigrationPanelBindings(row.id, {
        idempotencyKey: key.current({ id: row.id, bindings }),
        bindings,
      }),
    onSuccess: () => {
      key.settle();
      invalidate();
    },
    onError: (error) => key.settleOn(error, { onConflict: invalidate }),
  });
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
            value={chosen[target.codePanel] ?? ''}
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
        ) : initial[target.codePanel] !== undefined ? (
          <span>{nameOf(initial[target.codePanel] ?? '')}</span>
        ) : (
          <span className="muted">—</span>
        ),
    },
  ];
  const customers = row.dryRunReport?.wallets.customers;
  return (
    <Card title={stepTitle(4)} hint={t('web.lmg_panels_hint')}>
      {targets.length === 0 ? (
        <p className="muted">{t('web.lmg_panels_after_verify')}</p>
      ) : (
        <>
          {!mayViewPanels && <Banner tone="neutral">{t('web.lmg_panels_need_view')}</Banner>}
          {editable && panels.isSuccess && rickpanels.length === 0 && (
            <Banner tone="warn">{t('web.lmg_no_rickpanel')}</Banner>
          )}
          <DataTable
            columns={columns}
            rows={targets}
            rowKey={(target) => target.codePanel}
            caption={t('web.lmg_step_panels')}
            dense
          />
          {editable && (
            <div className="btn-group">
              <Button
                variant="primary"
                disabled={bindings.length !== targets.length || save.isPending}
                onClick={() => save.mutate()}
              >
                {t('web.lmg_panels_save')}
              </Button>
              {row.status === 'DRY_RUN_DONE' && (
                <span className="muted small">{t('web.lmg_panels_resets_dry_run')}</span>
              )}
            </div>
          )}
          {save.error !== null && <Banner tone="danger">{legacyMigrationFault(save.error)}</Banner>}
        </>
      )}
      {customers !== undefined && (
        <KV items={[[t('web.lmg_customers'), <Num key="c" value={customers} />]]} />
      )}
    </Card>
  );
}

// --- step 5: money and ownership ----------------------------------------------------------------

function MoneyCard({
  row,
  capabilities,
  mayManage,
}: {
  row: LegacyMigrationImportView;
  capabilities: LegacyMigrationCapabilitiesResponse;
  mayManage: boolean;
}) {
  const report = row.dryRunReport;
  const invalidate = useInvalidate();
  const [file, setFile] = useState<File | null>(null);
  const tooLarge = file !== null && file.size > capabilities.maxDecisionsBytes;
  const upload = useMutation({
    mutationFn: (chosen: File) => uploadLegacyMigrationDecisions(row.id, chosen),
    onSuccess: () => {
      setFile(null);
      invalidate();
    },
  });
  const decisionsOpen =
    mayManage &&
    (LEGACY_MIGRATION_COMMAND_STATES.uploadDecisions as readonly string[]).includes(row.status);
  return (
    <Card title={stepTitle(5)} hint={t('web.lmg_money_hint')}>
      {report === null ? (
        <p className="muted">{t('web.lmg_money_after_dry_run')}</p>
      ) : (
        <>
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
          <Banner tone="info">{t('web.lmg_debts_never_collected')}</Banner>
          <h3 className="card-subtitle">{t('web.lmg_ownership_title')}</h3>
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
        </>
      )}
      <p className="muted small">
        {row.decisionsPresent ? t('web.lmg_decisions_present') : t('web.lmg_decisions_absent')}
      </p>
      {decisionsOpen && (
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
    </Card>
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

// --- step 6: the final approval -----------------------------------------------------------------

function ApprovalCard({
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
  const digest = row.dryRunSha256;
  const approve = useMutation({
    mutationFn: () => {
      const body = { dryRunSha256: digest ?? '', confirmation: phrase };
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
  const awaiting = row.status === 'DRY_RUN_DONE' && digest !== null;
  return (
    <Card title={stepTitle(6)} hint={t('web.lmg_approval_hint')}>
      {row.approvedDryRunSha256 !== null && (
        <KV
          items={[
            [t('web.lmg_approved_digest'), <Copyable key="d" value={row.approvedDryRunSha256} />],
            [
              t('web.lmg_approved_at'),
              row.approvedAt === null ? '—' : formatTimestamp(row.approvedAt),
            ],
          ]}
        />
      )}
      {!awaiting && row.approvedDryRunSha256 === null && (
        <p className="muted">{t('web.lmg_approval_after_dry_run')}</p>
      )}
      {(awaiting || row.status === 'APPROVED') && capabilities.productionLikeTarget && (
        <ProductionGate row={row} capabilities={capabilities} />
      )}
      {awaiting && !mayApply && <Banner tone="neutral">{t('web.lmg_approval_owner_only')}</Banner>}
      {awaiting && mayApply && (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (phrase === capabilities.approvalPhrase) approve.mutate();
          }}
        >
          <Banner tone="danger">{t('web.lmg_approval_warning')}</Banner>
          <KV items={[[t('web.lmg_dry_run_digest'), <Copyable key="d" value={digest ?? ''} />]]} />
          <Field
            label={t('web.lmg_approval_phrase').replace('{phrase}', capabilities.approvalPhrase)}
            htmlFor="lmg-phrase"
          >
            <Input
              id="lmg-phrase"
              dir="ltr"
              autoComplete="off"
              className="recovery-phrase"
              value={phrase}
              onChange={(event) => setPhrase(event.currentTarget.value)}
            />
          </Field>
          <div className="btn-group">
            <Button
              type="submit"
              variant="danger-solid"
              disabled={phrase !== capabilities.approvalPhrase || approve.isPending}
            >
              {t('web.lmg_approve')}
            </Button>
          </div>
          {approve.error !== null && (
            <Banner tone="danger">{legacyMigrationFault(approve.error)}</Banner>
          )}
        </form>
      )}
    </Card>
  );
}

/**
 * A production-like target's two operator actions, said where the operator needs them: the
 * server operator sets the target acknowledgement in the `migration` process's environment
 * (shown here; a digest, not a secret — and never accepted from this page), and the owner
 * records the cutover approval of the dry run's seven values at `/legacy-cutover`, with sales
 * stopped. The page cannot do either; the import waits until both are true.
 */
function ProductionGate({
  row,
  capabilities,
}: {
  row: LegacyMigrationImportView;
  capabilities: LegacyMigrationCapabilitiesResponse;
}) {
  const onLink = useLinkHandler();
  const values = row.dryRunReport?.cutover ?? null;
  const blocker = row.progress.blocker;
  return (
    <div className="stack">
      {blocker !== null && <Banner tone="warn">{t(BLOCKER_LABELS[blocker])}</Banner>}
      <Banner tone="warn">{t('web.lmg_production_like')}</Banner>
      {capabilities.targetAcknowledgement !== null && (
        <KV
          items={[
            [
              t('web.lmg_ack_env'),
              <Copyable
                key="a"
                value={`NEXA_LEGACY_IMPORT_TARGET_ACK=${capabilities.targetAcknowledgement}`}
              />,
            ],
          ]}
        />
      )}
      {values !== null && (
        <>
          <p className="muted small">{t('web.lmg_cutover_values')}</p>
          <KV
            items={CUTOVER_FIELDS.map(([field, label]) => [
              t(label),
              <Copyable key={field} value={values[field]} />,
            ])}
          />
        </>
      )}
      <p className="small">
        <a className="link" href="/legacy-cutover" onClick={onLink}>
          {t('web.lmg_cutover_link')}
        </a>
      </p>
    </div>
  );
}

// --- step 7: the import ------------------------------------------------------------------------

function ImportCard({ row }: { row: LegacyMigrationImportView }) {
  const started =
    row.status === 'APPROVED' || row.status === 'APPLYING' || row.progress.applyAttempts > 0;
  return (
    <Card title={stepTitle(7)} hint={t('web.lmg_import_hint')}>
      {!started ? (
        <p className="muted">{t('web.lmg_import_after_approval')}</p>
      ) : (
        <KV
          items={[
            [
              t('web.lmg_status'),
              <Badge key="s" tone={STATUS_TONES[row.status]}>
                {t(STATUS_LABELS[row.status])}
              </Badge>,
            ],
            [
              t('web.lmg_phase'),
              row.progress.phase === null ? '—' : t(PHASE_LABELS[row.progress.phase]),
            ],
            [t('web.lmg_apply_attempts'), <Num key="a" value={row.progress.applyAttempts} />],
            [t('web.lmg_working_now'), row.working ? t('web.lmg_yes') : t('web.lmg_no')],
          ]}
        />
      )}
      {row.status === 'APPLYING' && row.progress.applyAttempts > 1 && (
        <Banner tone="info">{t('web.lmg_resumed')}</Banner>
      )}
    </Card>
  );
}

// --- step 8: report, reconciliation, audit, backup --------------------------------------------

function ReportCard({ row }: { row: LegacyMigrationImportView }) {
  const onLink = useLinkHandler();
  const report = row.applyReport;
  return (
    <Card title={stepTitle(8)} hint={t('web.lmg_report_hint')}>
      {report === null ? (
        <p className="muted">{t('web.lmg_report_after_import')}</p>
      ) : (
        <>
          {!report.reportHolds && <Banner tone="warn">{t('web.lmg_report_discrepancy')}</Banner>}
          <KV
            items={[
              [t('web.lmg_importer_verdict'), <Ltr key="i">{report.importerVerdict}</Ltr>],
              [
                t('web.lmg_reconcile_verdict'),
                report.reconcileVerdict === 'RECONCILED'
                  ? t('web.lmg_reconciled')
                  : t('web.lmg_discrepancy'),
              ],
              [t('web.lmg_report_holds'), report.reportHolds ? t('web.lmg_yes') : t('web.lmg_no')],
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
          <SectionTable rows={report.sections} />
          <CodeCounts title={t('web.lmg_history')} rows={report.history} />
        </>
      )}
      <p className="small">
        <a className="link" href="/audit-log" onClick={onLink}>
          {t('web.lmg_audit_link')}
        </a>
      </p>
    </Card>
  );
}

// --- shared pieces ------------------------------------------------------------------------------

function SectionTable({ rows }: { rows: readonly LegacyMigrationSectionCounts[] }) {
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
      <h3 className="card-subtitle">{title}</h3>
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

function History({ rows }: { rows: readonly LegacyMigrationImportView[] }) {
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
      key: 'at',
      header: t('web.lmg_uploaded_at'),
      render: (row) => formatTimestamp(row.createdAt),
    },
  ];
  return (
    <Card title={t('web.lmg_history_title')}>
      <DataTable
        columns={columns}
        rows={[...rows]}
        rowKey={(row) => row.id}
        caption={t('web.lmg_history_title')}
        dense
      />
    </Card>
  );
}
