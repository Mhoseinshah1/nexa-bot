import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { keepPageWhileTurning } from '../ui/paging';
import {
  RECOVERY_CONFIRMATION_PHRASE,
  isLegacyNxpkgTerminalStatus,
  isRecoveryConfirmationPhrase,
  type BackupRunSummary,
  type RecoveryRequestSummary,
  type PermissionKey,
} from '@nexa/contracts';
import {
  backupArchiveUrl,
  confirmRecovery,
  uploadLegacyMigrationPackage,
  fetchBackupHistory,
  fetchBackupStatus,
  fetchRecoveries,
  fetchRecoveryCapabilities,
  runBackupNow,
  uploadRecoveryArchive,
  verifyRecovery,
} from '../api/client';
import { formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { pollUnlessFinal } from '../polling';
import { RUN_KEY_HELD_MS, useSubmissionKey } from '../submission-key';
import { setQuery, useLinkHandler, type Route } from '../router';
import {
  Badge,
  Banner,
  Card,
  Copyable,
  CursorPager,
  DataTable,
  Duration,
  Empty,
  KV,
  Ltr,
  Num,
  PageHead,
  StatCard,
  StateSwitch,
  StatusDot,
  type Column,
} from '../ui/kit';
import { FilePicker } from '../ui/file-picker';
import { Icon } from '../ui/icons';
import { BackupScheduleCard } from './backup-schedule';
import { CodeName } from './code-name';
import { RecoveryKitSection } from './recovery-kit';
import {
  BACKUP_RUN_STATE_LABELS,
  RECOVERY_MIGRATION_VERDICT_LABELS,
  RECOVERY_STAGE_LABELS,
  RECOVERY_STATE_LABELS,
  recoveryErrorText,
  recoveryFailureText,
} from '../recovery-failure-labels';
import {
  MirzaHistory,
  MirzaRestoreFlow,
  MirzaSteps,
  importedSources,
  legacyMigrationFault,
  mirzaAccess,
  sniffRestoreFile,
  useMirzaImports,
  type MirzaAccess,
  type RestoreFileKind,
} from './recovery-mirza';
import { ErrorRef } from '../ui/technical-details';

/**
 * Backup and disaster recovery.
 *
 * Four sections, in the order an operator needs them: is the backup working,
 * what has it produced, what is the newest thing that could actually be
 * restored, and — last, because it is the dangerous one — restore from it.
 *
 * NOTHING HERE IS FAKE. Every control calls a real endpoint, and a capability
 * this installation does not have says so in the place an operator would look
 * for it rather than being hidden: uploading is reported off when it is off.
 * An archive from ANOTHER installation is restorable once that installation's
 * Recovery Kit is imported (ADR-0032), and the section that does it sits above
 * the upload, in the order an operator on a fresh server needs it.
 *
 * `permission` decides what is DRAWN and never what is allowed. The server
 * re-checks every call, and this page would be exactly as safe if it drew all of
 * it — which is why the restore section renders a REFUSAL for an actor without
 * `recovery.restore` rather than vanishing: an operator who can verify their
 * archives but not restore them needs to know that is the arrangement.
 */

/** Often enough to watch a backup run; not so often it polls a quiet page hard. */
const STATUS_REFRESH_MS = 15_000;
const HISTORY_PAGE = 10;

export function RecoveryPage({
  route,
  permissions,
}: {
  route: Route;
  permissions: readonly PermissionKey[];
}) {
  const onLink = useLinkHandler();
  const client = useQueryClient();
  const mayView = permissions.includes('backup.view');
  const mayRun = permissions.includes('backup.run');
  const mayDownload = permissions.includes('backup.download');
  const mayRestore = permissions.includes('recovery.restore');
  const mirza = mirzaAccess(permissions);

  const cursor = route.query.get('cursor') ?? undefined;

  const status = useQuery({
    queryKey: ['backup-status'],
    queryFn: fetchBackupStatus,
    enabled: mayView,
    refetchInterval: pollUnlessFinal(STATUS_REFRESH_MS),
  });
  const history = useQuery(
    keepPageWhileTurning({
      queryKey: ['backup-history', cursor ?? null],
      queryFn: () =>
        fetchBackupHistory({ limit: HISTORY_PAGE, ...(cursor === undefined ? {} : { cursor }) }),
      enabled: mayView,
      refetchInterval: pollUnlessFinal(STATUS_REFRESH_MS),
    }),
  );
  const capabilities = useQuery({
    queryKey: ['recovery-capabilities'],
    queryFn: fetchRecoveryCapabilities,
    enabled: mayView,
  });
  const recoveries = useQuery({
    queryKey: ['recoveries'],
    queryFn: () => fetchRecoveries({ limit: HISTORY_PAGE }),
    enabled: mayView,
    refetchInterval: pollUnlessFinal(STATUS_REFRESH_MS),
  });

  const refreshAll = () => {
    void client.invalidateQueries({ queryKey: ['backup-status'] });
    void client.invalidateQueries({ queryKey: ['backup-history'] });
    void client.invalidateQueries({ queryKey: ['recoveries'] });
    // A refused upload may mean uploads were switched off after this page loaded (or
    // another replica disagrees); re-reading the capabilities lets the page say so.
    void client.invalidateQueries({ queryKey: ['recovery-capabilities'] });
  };

  /*
   * One key per press, kept across the automatic retry and a re-press after an ambiguous
   * failure (`useSubmissionKey`). Minting it inside `mutationFn` gave the client's own
   * 5xx retry a FRESH key, so a lost answer could start a second backup run.
   */
  // A lost answer is re-asked for a few minutes; after that a press is a new backup.
  const runNowKey = useSubmissionKey({ heldForMs: RUN_KEY_HELD_MS });
  const runNow = useMutation({
    mutationFn: () => runBackupNow({ idempotencyKey: runNowKey.current('run-now') }),
    onSuccess: () => {
      runNowKey.settle();
      refreshAll();
    },
    onError: (error) => runNowKey.settleOn(error),
  });

  const runs = history.data?.runs ?? [];
  const nextCursor = history.data?.nextCursor ?? null;

  return (
    <>
      <PageHead title={t('web.recovery_title')} subtitle={t('web.recovery_intro')} />

      {status.data?.quiesced === true && (
        <Banner tone="danger" title={t('web.recovery_quiesced')}>
          {t('web.recovery_displaced_hint')}
        </Banner>
      )}

      <Card title={t('web.recovery_status_title')}>
        <StateSwitch query={status} denied={!mayView}>
          <BackupStatus
            status={status.data}
            mayRun={mayRun}
            busy={runNow.isPending}
            outcome={runNow.data?.outcome}
            error={runNow.error}
            onRun={() => runNow.mutate()}
          />
        </StateSwitch>
      </Card>

      {/* Spec 13.2: the automatic schedule, where its backups are. */}
      <Card title={t('web.backup_schedule_title')} hint={t('web.backup_schedule_hint')}>
        <StateSwitch query={status} denied={!mayView}>
          {status.data !== undefined && (
            <BackupScheduleCard status={status.data} permissions={permissions} />
          )}
        </StateSwitch>
      </Card>

      <Card title={t('web.recovery_last_success_title')}>
        <StateSwitch query={history} denied={!mayView}>
          <LastSuccess runs={runs} mayDownload={mayDownload} />
        </StateSwitch>
      </Card>

      <Card title={t('web.recovery_history_title')}>
        <StateSwitch
          query={history}
          denied={!mayView}
          isEmpty={runs.length === 0}
          empty={
            <Empty title={t('web.recovery_no_backups')} hint={t('web.recovery_no_backups_hint')} />
          }
        >
          <DataTable
            columns={historyColumns(mayDownload)}
            rows={runs}
            rowKey={(run) => run.id}
            caption={t('web.recovery_history_title')}
            dense
          />
          <CursorPager
            order="newest-first"
            onPrevious={() => setQuery(route, 'cursor', null)}
            onNext={() => setQuery(route, 'cursor', nextCursor)}
            hasPrevious={cursor !== undefined}
            hasNext={nextCursor !== null}
            shown={runs.length}
          />
        </StateSwitch>
      </Card>

      {/*
        The Recovery Kit (ADR-0032), ABOVE the upload: on a fresh server the kit
        is imported first and the old server's backup uploaded second, and the
        page reads in the order the operator acts.
      */}
      <RecoveryKitSection permissions={permissions} />

      <Card
        title={t('web.recovery_operations_title')}
        hint={t('web.recovery_upload_hint')}
        className="recovery-operations"
      >
        {/*
          A Mirza restore is authorised by `legacy.migration.*`, not by `backup.view` (Codex
          review on #278): an administrator holding only the migration permissions gets the
          Mirza half of this card, without the NEXA capabilities they may not read.
        */}
        {!mayView && mirza.mayView ? (
          <RecoveryOperations
            nexaAllowed={false}
            uploadEnabled={false}
            maxUploadBytes={0}
            mayRestore={false}
            mirza={mirza}
            onChanged={refreshAll}
          />
        ) : (
          <StateSwitch query={capabilities} denied={!mayView}>
            <RecoveryOperations
              nexaAllowed
              uploadEnabled={capabilities.data?.uploadEnabled ?? false}
              maxUploadBytes={capabilities.data?.maxUploadBytes ?? 0}
              mayRestore={mayRestore}
              mirza={mirza}
              onChanged={refreshAll}
            />
          </StateSwitch>
        )}
      </Card>

      <Card title={t('web.recovery_requests_title')}>
        <StateSwitch
          query={recoveries}
          denied={!mayView}
          isEmpty={(recoveries.data?.recoveries ?? []).length === 0}
          empty={<Empty title={t('web.recovery_no_requests')} />}
        >
          <DataTable
            columns={recoveryColumns()}
            rows={recoveries.data?.recoveries ?? []}
            rowKey={(row) => row.id}
            caption={t('web.recovery_requests_title')}
            dense
          />
        </StateSwitch>
      </Card>

      <span hidden onClick={onLink} />
    </>
  );
}

function BackupStatus({
  status,
  mayRun,
  busy,
  outcome,
  error,
  onRun,
}: {
  status:
    | {
        scheduleEnabled: boolean;
        intervalMs: number;
        lastSucceededAt: string | null;
        running: BackupRunSummary | null;
        unknownDeliveries: number;
        quiesced: boolean;
      }
    | undefined;
  mayRun: boolean;
  busy: boolean;
  outcome: 'COMPLETED' | 'BUSY' | undefined;
  error: unknown;
  onRun: () => void;
}) {
  if (status === undefined) return null;
  return (
    <>
      <div className="stat-grid recovery-stats">
        <StatCard
          label={t('web.recovery_schedule')}
          icon="calendar"
          value={
            <StatusDot tone={status.scheduleEnabled ? 'ok' : 'warn'}>
              {status.scheduleEnabled
                ? t('web.recovery_schedule_on')
                : t('web.recovery_schedule_off')}
            </StatusDot>
          }
          {...(status.scheduleEnabled ? {} : { tone: 'warn' as const })}
        />
        <StatCard
          label={t('web.recovery_interval')}
          icon="clock"
          value={<Duration ms={status.intervalMs} />}
        />
        <StatCard
          label={t('web.recovery_last_success')}
          icon="check"
          value={
            status.lastSucceededAt === null ? (
              <Badge tone="danger">{t('web.recovery_never')}</Badge>
            ) : (
              <span className="recovery-stat-time">{formatTimestamp(status.lastSucceededAt)}</span>
            )
          }
          {...(status.lastSucceededAt === null ? { tone: 'alert' as const } : {})}
        />
        <StatCard
          label={t('web.recovery_unknown_deliveries')}
          icon="send"
          value={<Num value={status.unknownDeliveries} />}
          {...(status.unknownDeliveries > 0 ? { tone: 'warn' as const } : {})}
        />
      </div>

      {/*
        A green history with the schedule off is the shape that reads as healthy
        and is not, so it is called out rather than left to be inferred from a
        badge.
      */}
      {!status.scheduleEnabled && (
        <Banner tone="warn">{t('web.recovery_schedule_off_hint')}</Banner>
      )}
      {status.unknownDeliveries > 0 && (
        <Banner tone="warn">{t('web.recovery_unknown_deliveries_hint')}</Banner>
      )}
      {status.running !== null && (
        <Banner tone="info" title={t('web.recovery_running')}>
          <Ltr>{status.running.id}</Ltr>
        </Banner>
      )}

      {mayRun && (
        <div className="btn-group">
          <button
            type="button"
            className="btn primary"
            onClick={onRun}
            disabled={busy || status.quiesced}
          >
            <Icon name="database" />
            {busy ? t('web.recovery_running_now') : t('web.recovery_run_now')}
          </button>
        </div>
      )}
      {/* BUSY is not a failure: one backup at a time is the invariant working. */}
      {outcome === 'BUSY' && <Banner tone="warn">{t('web.recovery_run_busy')}</Banner>}
      {outcome === 'COMPLETED' && <Banner tone="ok">{t('web.recovery_run_done')}</Banner>}
      {error !== null && error !== undefined && (
        <Banner tone="danger">
          {recoveryErrorText(error)}
          <ErrorRef error={error} />
        </Banner>
      )}
    </>
  );
}

/**
 * The newest run that actually produced a verified artifact.
 *
 * Computed from the page in hand, and that is sound ONLY because the server
 * orders newest-first and this is page one — the same reasoning the dashboard's
 * cards use. It is not a sort: re-ordering the ten rows a page holds would be
 * the one-page-ordering defect the table refuses to commit.
 */
function LastSuccess({
  runs,
  mayDownload,
}: {
  runs: readonly BackupRunSummary[];
  mayDownload: boolean;
}) {
  const newest = runs.find((run) => run.state === 'SUCCEEDED' && run.verifiedAt !== null);
  if (newest === undefined) {
    return <Empty title={t('web.recovery_no_backups')} hint={t('web.recovery_no_backups_hint')} />;
  }
  return (
    <div className="stack">
      <KV
        items={[
          [t('web.recovery_backup_id'), <Copyable key="id" value={newest.id} />],
          [t('web.recovery_started'), formatTimestamp(newest.startedAt)],
          [
            t('web.recovery_finished'),
            newest.finishedAt === null ? '—' : formatTimestamp(newest.finishedAt),
          ],
          [t('web.recovery_dump_size'), <Bytes key="d" value={newest.dumpBytes} />],
          [
            t('web.recovery_verified'),
            <Badge key="v" tone="ok">
              {t('web.recovery_verified_yes')}
            </Badge>,
          ],
          [t('web.recovery_checksum'), <Copyable key="c" value={newest.checksum ?? ''} />],
          [t('web.recovery_archive_size'), <Bytes key="b" value={newest.archiveBytes} />],
          [t('web.recovery_delivery'), <DeliveryBadge key="d" outcome={newest.deliveryState} />],
        ]}
      />
      {/*
        A cleanup that did not complete means PLAINTEXT database bytes, or a
        scratch database, are still on the operator's server. The run is a
        success and this is still something they have to be told, which is why
        the pipeline records it on a column rather than in a log line.
      */}
      {!newest.cleanupOk && (
        <Banner tone="warn" title={t('web.recovery_cleanup_incomplete')}>
          {t('web.recovery_cleanup_hint')}
        </Banner>
      )}
      <DownloadControl run={newest} mayDownload={mayDownload} />
    </div>
  );
}

/**
 * The download, or the truthful reason there is none.
 *
 * Three states, and the third is why this is a component rather than a button:
 * the operator may not hold the CRITICAL permission, or the local artifact may
 * be gone. Nothing retains archives for ever to keep a button lit — ADR-0011's
 * pruning control is not in V1 — so «فایل محلی دیگر موجود نیست» is an ordinary
 * outcome and says where the file might still be.
 */
function DownloadControl({ run, mayDownload }: { run: BackupRunSummary; mayDownload: boolean }) {
  if (!mayDownload) return null;
  if (!run.archiveAvailable) {
    return (
      <Banner tone="neutral" title={t('web.recovery_download_gone')}>
        {t('web.recovery_download_gone_hint')}
      </Banner>
    );
  }
  return (
    <div className="btn-group">
      {/*
        A plain anchor, not a fetch: the browser's own download is what should
        carry a multi-gigabyte file to disk. Reading it through `fetch` would
        buffer the whole archive in this tab to hand it straight back as a blob.
      */}
      <a className="btn" href={backupArchiveUrl(run.id)}>
        <Icon name="download" />
        {t('web.recovery_download')}
      </a>
    </div>
  );
}

/**
 * Upload, verify, and — behind a typed confirmation — restore.
 *
 * Two restore sources share the one file input, told apart by the file's own first bytes and
 * never by its name (`sniffRestoreFile`): a NEXA backup archive (`.nxb`) takes the restore
 * below exactly as before, and the Mirza converter's package (`.nxpkg`) takes the Mirza flow
 * (`recovery-mirza.tsx`) — upload, review, confirm, run — over the same import row the
 * `recovery` role executes. Anything else is refused here, before a byte is uploaded.
 */
function RecoveryOperations({
  nexaAllowed,
  uploadEnabled,
  maxUploadBytes,
  mayRestore,
  mirza,
  onChanged,
}: {
  /** False for an actor without `backup.view`: the card is their Mirza restore only. */
  nexaAllowed: boolean;
  uploadEnabled: boolean;
  maxUploadBytes: number;
  mayRestore: boolean;
  mirza: MirzaAccess;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  /** The chosen file's source, or null while its first bytes are read. */
  const [kind, setKind] = useState<RestoreFileKind | null>(null);
  const chosenRef = useRef<File | null>(null);
  const [current, setCurrent] = useState<RecoveryRequestSummary | null>(null);
  /** Which source the card shows below the input: the last one uploaded here. */
  const [shown, setShown] = useState<'NEXA' | 'MIRZA' | null>(null);
  const [mirzaId, setMirzaId] = useState<string | null>(null);
  const [phrase, setPhrase] = useState('');

  const imports = useMirzaImports(mirza.mayView);
  const mirzaReady = mirza.mayView && imports.enabled && imports.capabilities !== null;

  const upload = useMutation({
    mutationFn: (chosen: File) => uploadRecoveryArchive(chosen),
    onSuccess: (result) => {
      setCurrent(result.recovery);
      setShown('NEXA');
      onChanged();
    },
    // A refusal may have left a FAILED row (oversized, empty) or none at all (uploads
    // disabled); either way the list and the capabilities are re-read.
    onError: () => onChanged(),
  });
  const mirzaUpload = useMutation({
    mutationFn: (chosen: File) => uploadLegacyMigrationPackage(chosen),
    onSuccess: (result) => {
      setMirzaId(result.import.id);
      setShown('MIRZA');
      void queryClient.invalidateQueries({ queryKey: ['legacy-migration'] });
    },
  });
  const verify = useMutation({
    mutationFn: (id: string) => verifyRecovery(id),
    onSuccess: (result) => {
      setCurrent(result.recovery);
      onChanged();
    },
  });
  const confirmKey = useSubmissionKey();
  const confirm = useMutation({
    mutationFn: (input: { id: string; checksum: string }) => {
      const body = { id: input.id, phrase, artifactChecksum: input.checksum };
      return confirmRecovery({ ...body, idempotencyKey: confirmKey.current(body) });
    },
    onSuccess: (result) => {
      confirmKey.settle();
      setCurrent(result.recovery);
      onChanged();
    },
    onError: (error) => confirmKey.settleOn(error),
  });

  /*
   * The Mirza import this card shows: the one uploaded here; else an unfinished one (an import
   * outlives a reload, and its progress is what the operator came back for), which stays shown
   * once it finishes so its result is not snatched away mid-read.
   */
  const activeId = imports.rows.find((row) => !isLegacyNxpkgTerminalStatus(row.status))?.id ?? null;
  const [followed, setFollowed] = useState<string | null>(null);
  useEffect(() => {
    if (activeId !== null) setFollowed(activeId);
  }, [activeId]);
  const focusId = mirzaId ?? activeId ?? followed;
  const mirzaRow =
    imports.rows.find((row) => row.id === focusId) ??
    (mirzaUpload.data !== undefined && mirzaUpload.data.import.id === focusId
      ? mirzaUpload.data.import
      : null);
  const showMirza = shown !== 'NEXA' && mirzaRow !== null && imports.capabilities !== null;

  if (!uploadEnabled && !mirzaReady) {
    return <Banner tone="neutral">{t('web.recovery_upload_disabled')}</Banner>;
  }

  const onChoose = (chosen: File | null): void => {
    chosenRef.current = chosen;
    setFile(chosen);
    setKind(null);
    if (chosen === null) return;
    // The answer for a file the operator has since replaced is dropped.
    void sniffRestoreFile(chosen)
      .catch((): RestoreFileKind => 'UNKNOWN')
      .then((found) => {
        if (chosenRef.current === chosen) setKind(found);
      });
  };

  // Refused HERE as well as on the server, so an operator is not made to upload a gigabyte
  // to be told the limit. The server's counter is still the authority; this is a courtesy,
  // and it reports the real configured limit rather than a number this page invented.
  const limit = kind === 'MIRZA' ? (imports.capabilities?.maxUploadBytes ?? 0) : maxUploadBytes;
  const tooLarge = file !== null && kind !== null && kind !== 'UNKNOWN' && file.size > limit;
  const refusal: string | null =
    file === null || kind === null
      ? null
      : kind === 'UNKNOWN'
        ? t('web.recovery_file_unknown')
        : kind === 'NEXA' && !nexaAllowed
          ? t('web.recovery_no_permission_nexa')
          : kind === 'NEXA' && !uploadEnabled
            ? t('web.recovery_upload_disabled')
            : kind === 'MIRZA' && !mirza.mayManage
              ? t('web.mrz_no_permission')
              : kind === 'MIRZA' && !mirzaReady
                ? t('web.lmg_disabled')
                : null;
  const pending = upload.isPending || mirzaUpload.isPending;

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (file === null || tooLarge || refusal !== null) return;
    if (kind === 'NEXA') upload.mutate(file);
    if (kind === 'MIRZA') mirzaUpload.mutate(file);
  };

  return (
    <>
      {showMirza ? <MirzaSteps row={mirzaRow} /> : <RecoverySteps current={current} />}
      {nexaAllowed && !uploadEnabled && (
        <Banner tone="neutral">{t('web.recovery_upload_disabled')}</Banner>
      )}
      <h3 className="card-subtitle">{t('web.recovery_upload_title')}</h3>
      <form onSubmit={onSubmit} className="stack">
        <div className="field">
          <span className="field-label">{t('web.recovery_upload_choose')}</span>
          <FilePicker
            id="recovery-file"
            label={t('web.recovery_upload_choose')}
            describedBy="recovery-file-kind"
            kind="backup"
            accept={!nexaAllowed ? '.nxpkg' : mirza.mayView ? '.nxb,.nxpkg' : '.nxb'}
            extensions={!nexaAllowed ? ['.nxpkg'] : mirza.mayView ? ['.nxb', '.nxpkg'] : ['.nxb']}
            selected={file}
            onFiles={(files) => onChoose(files[0] ?? null)}
            onClear={() => onChoose(null)}
          />
        </div>
        <p className="muted small" id="recovery-file-kind" aria-live="polite">
          {file === null
            ? t('web.recovery_file_hint')
            : kind === null
              ? t('web.recovery_file_reading')
              : kind === 'NEXA'
                ? t('web.recovery_file_nexa')
                : kind === 'MIRZA'
                  ? t('web.recovery_file_mirza')
                  : ''}
        </p>
        {refusal !== null && <Banner tone="danger">{refusal}</Banner>}
        {kind === 'MIRZA' && refusal === null && (
          <Banner tone="warn" icon="info">
            {t('web.lmg_banner')}
          </Banner>
        )}
        {tooLarge && (
          <Banner tone="danger">
            {kind === 'MIRZA' ? t('web.lmg_fault_too_large') : t('web.recovery_upload_too_large')}
          </Banner>
        )}
        <div className="btn-group">
          <button
            type="submit"
            className="btn primary"
            disabled={file === null || kind === null || tooLarge || refusal !== null || pending}
          >
            <Icon name="upload" />
            {pending ? t('web.recovery_uploading') : t('web.recovery_upload_send')}
          </button>
        </div>
        {upload.error !== null && (
          <Banner tone="danger">
            {recoveryErrorText(upload.error)}
            <ErrorRef error={upload.error} />
          </Banner>
        )}
        {mirzaUpload.error !== null && (
          <Banner tone="danger">
            {legacyMigrationFault(mirzaUpload.error)}
            <ErrorRef error={mirzaUpload.error} />
          </Banner>
        )}
      </form>

      {showMirza && imports.capabilities !== null && (
        <MirzaRestoreFlow
          row={mirzaRow}
          capabilities={imports.capabilities}
          access={mirza}
          imported={importedSources(imports.rows)}
        />
      )}
      {mirzaReady && (
        <MirzaHistory rows={imports.rows.filter((row) => !(showMirza && row.id === mirzaRow.id))} />
      )}

      {shown !== 'MIRZA' && current !== null && (
        <div className="stack inset">
          <KV
            items={[
              [
                t('web.recovery_state'),
                <Badge key="s" tone={stateTone(current.state)} title={current.state}>
                  {t(RECOVERY_STATE_LABELS[current.state])}
                </Badge>,
              ],
              [
                t('web.recovery_stage'),
                <span key="g" title={current.stage}>
                  {t(RECOVERY_STAGE_LABELS[current.stage])}
                </span>,
              ],
              ...(current.verification === null
                ? []
                : ([
                    [t('web.recovery_taken_at'), formatTimestamp(current.verification.takenAt)],
                    [
                      t('web.recovery_source_database'),
                      <Ltr key="db">{current.verification.databaseName}</Ltr>,
                    ],
                    [
                      t('web.recovery_checksum'),
                      <Copyable key="c" value={current.verification.checksum} />,
                    ],
                  ] as [React.ReactNode, React.ReactNode][])),
              ...(current.restoreTest === null
                ? []
                : ([
                    [
                      t('web.recovery_tables_restored'),
                      <Num key="tc" value={current.restoreTest.tableCount} />,
                    ],
                    [
                      t('web.recovery_migration_verdict'),
                      <CodeName
                        key="mv"
                        value={current.restoreTest.migrationVerdict}
                        labels={RECOVERY_MIGRATION_VERDICT_LABELS}
                      />,
                    ],
                  ] as [React.ReactNode, React.ReactNode][])),
            ]}
          />

          {current.failureCode !== null && (
            // C1: the failure in words, its code small and left-to-right beneath it (the row
            // that showed the bare code as its value is folded into this banner).
            <Banner tone="danger">
              {recoveryFailureText(current.failureCode)}
              <p className="err-ref muted small">
                <span>{t('web.err_ref_code')}</span>{' '}
                <bdi dir="ltr" className="ltr mono">
                  {current.failureCode}
                </bdi>
              </p>
            </Banner>
          )}

          {current.state === 'UPLOADED' && (
            <>
              <p className="muted small">{t('web.recovery_verify_hint')}</p>
              <div className="btn-group">
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => verify.mutate(current.id)}
                  disabled={verify.isPending}
                >
                  {verify.isPending ? t('web.recovery_verifying') : t('web.recovery_verify')}
                </button>
              </div>
            </>
          )}
          {verify.error !== null && (
            <Banner tone="danger">
              {recoveryErrorText(verify.error)}
              <ErrorRef error={verify.error} />
            </Banner>
          )}

          {current.state === 'RESTORE_TEST_PASSED' && (
            <RestoreConfirmation
              recovery={current}
              mayRestore={mayRestore}
              phrase={phrase}
              onPhrase={setPhrase}
              busy={confirm.isPending}
              error={confirm.error}
              onConfirm={() =>
                confirm.mutate({ id: current.id, checksum: current.artifactChecksum ?? '' })
              }
            />
          )}
          {current.state === 'RESTORE_REQUESTED' && (
            <Banner tone="ok" title={t('web.recovery_confirmed')}>
              {current.confirmationExpiresAt === null
                ? null
                : `${t('web.recovery_confirm_expires')}: ${formatTimestamp(current.confirmationExpiresAt)}`}
            </Banner>
          )}
        </div>
      )}
    </>
  );
}

/** The request's progress through the three things a page may do: upload, verify, confirm. */
const VERIFYING_STATES: readonly RecoveryRequestSummary['state'][] = [
  'UPLOADED',
  'VERIFYING',
  'VERIFIED',
  'RESTORE_TESTING',
];

/**
 * The step a FAILED request failed in.
 *
 * Not the row's `stage`: every failure exit writes `CLEANUP` there, so the stage says what
 * was done AFTER the failure, not where it happened. What does say it is what the row
 * reached before it failed — a confirmation accepted means the destructive run is what
 * failed; a rejected upload never produced an archive to verify; and every other failure
 * before a confirmation is the verification and restore test, which is one call and one
 * step here. Verify answers HTTP 200 with such a row for a bad archive, so without this
 * the strip said verification had not started at the moment it had just failed.
 */
function failedStep(current: RecoveryRequestSummary): 1 | 2 | 3 {
  if (current.confirmedAt !== null) return 3;
  if (current.failureCode === 'recovery.upload_rejected') return 1;
  return 2;
}

type StepMark = 'done' | 'current' | 'failed' | 'todo';

/**
 * Where the request in hand stands, as three steps. Presentation only: which controls are
 * drawn is still decided by the request's own state below, exactly as before.
 */
function RecoverySteps({ current }: { current: RecoveryRequestSummary | null }) {
  const state = current?.state ?? null;
  const failedAt = current !== null && state === 'FAILED' ? failedStep(current) : null;
  const reached = (step: 1 | 2 | 3): StepMark => {
    if (state === null) return step === 1 ? 'current' : 'todo';
    if (failedAt !== null) return step < failedAt ? 'done' : step === failedAt ? 'failed' : 'todo';
    if (VERIFYING_STATES.includes(state))
      return step === 1 ? 'done' : step === 2 ? 'current' : 'todo';
    if (state === 'RESTORE_TEST_PASSED') return step === 3 ? 'current' : 'done';
    return 'done';
  };
  const steps: readonly [1 | 2 | 3, WebKey][] = [
    [1, 'web.recovery_upload_title'],
    [2, 'web.recovery_verify'],
    [3, 'web.recovery_restore_title'],
  ];
  return (
    <ol className="recovery-steps">
      {steps.map(([step, label]) => {
        const mark = reached(step);
        return (
          <li
            key={step}
            className={mark}
            // The failed step is where the request stopped, so it is the current one.
            aria-current={mark === 'current' || mark === 'failed' ? 'step' : undefined}
          >
            <span className="recovery-step-n" aria-hidden="true">
              {mark === 'done' ? (
                <Icon name="check" size={12} />
              ) : mark === 'failed' ? (
                <Icon name="x" size={12} />
              ) : (
                <Num value={step} />
              )}
            </span>
            <span>{t(label)}</span>
            {mark === 'failed' && (
              <span className="recovery-step-state">{t('web.status_failed')}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The confirmation, and the refusal an unprivileged actor gets instead.
 *
 * The section RENDERS for an actor without `recovery.restore` rather than
 * vanishing, stating that verification is still available to them. A hidden
 * section would leave them wondering whether the product has the capability,
 * which is the question the maturity vocabulary exists to answer.
 *
 * The button is disabled until the phrase matches, and the match is
 * `isRecoveryConfirmationPhrase` from the CONTRACT — the same function the
 * server uses. A local copy of the comparison is how a surface comes to accept
 * something the server refuses, or refuse something it accepts.
 */
function RestoreConfirmation({
  recovery,
  mayRestore,
  phrase,
  onPhrase,
  busy,
  error,
  onConfirm,
}: {
  recovery: RecoveryRequestSummary;
  mayRestore: boolean;
  phrase: string;
  onPhrase: (next: string) => void;
  busy: boolean;
  error: unknown;
  onConfirm: () => void;
}) {
  if (!mayRestore) {
    return <Banner tone="neutral">{t('web.recovery_no_permission_restore')}</Banner>;
  }
  const matches = isRecoveryConfirmationPhrase(phrase);
  return (
    <div className="stack inset danger-zone">
      <Banner tone="danger" title={t('web.recovery_restore_title')}>
        {t('web.recovery_restore_danger')}
      </Banner>
      <label className="field">
        <span className="field-label">{t('web.recovery_confirm_label')}</span>
        {/*
          The phrase is shown in an LTR run beside the field: it is eleven ASCII
          characters inside a right-to-left page, and an operator copying it out
          of a bidirectional paragraph is an operator typing it wrong.
        */}
        <Ltr>{RECOVERY_CONFIRMATION_PHRASE}</Ltr>
        <input
          type="text"
          className="input recovery-phrase"
          value={phrase}
          dir="ltr"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onPhrase(event.currentTarget.value)}
        />
      </label>
      {phrase !== '' && !matches && <Banner tone="warn">{t('web.recovery_confirm_wrong')}</Banner>}
      <div className="btn-group">
        <button
          type="button"
          className="btn danger solid"
          onClick={onConfirm}
          disabled={!matches || busy || recovery.artifactChecksum === null}
        >
          {t('web.recovery_confirm_button')}
        </button>
      </div>
      {error !== null && error !== undefined && (
        <Banner tone="danger">
          {recoveryErrorText(error)}
          <ErrorRef error={error} />
        </Banner>
      )}
    </div>
  );
}

function historyColumns(mayDownload: boolean): readonly Column<BackupRunSummary>[] {
  const columns: Column<BackupRunSummary>[] = [
    {
      key: 'started',
      header: t('web.recovery_started'),
      render: (run) => <span className="nowrap">{formatTimestamp(run.startedAt)}</span>,
    },
    {
      key: 'trigger',
      header: t('web.recovery_trigger'),
      render: (run) => <span className="nowrap">{triggerLabel(run.trigger)}</span>,
    },
    {
      key: 'state',
      header: t('web.recovery_state'),
      render: (run) => (
        <Badge tone={runTone(run)} title={run.state}>
          {t(BACKUP_RUN_STATE_LABELS[run.state])}
        </Badge>
      ),
    },
    {
      key: 'verified',
      header: t('web.recovery_verified'),
      render: (run) =>
        run.verifiedAt === null ? (
          <Badge tone="warn">{t('web.recovery_verified_no')}</Badge>
        ) : (
          <Badge tone="ok">{t('web.recovery_verified_yes')}</Badge>
        ),
    },
    {
      key: 'delivery',
      header: t('web.recovery_delivery'),
      render: (run) => <DeliveryBadge outcome={run.deliveryState} />,
    },
    {
      key: 'size',
      header: t('web.recovery_archive_size'),
      align: 'end',
      render: (run) => <Bytes value={run.archiveBytes} />,
    },
  ];
  if (mayDownload) {
    columns.push({
      key: 'download',
      header: t('web.recovery_download'),
      render: (run) =>
        run.archiveAvailable ? (
          <a className="link" href={backupArchiveUrl(run.id)}>
            {t('web.recovery_download')}
          </a>
        ) : (
          <span className="muted small">{t('web.recovery_download_gone')}</span>
        ),
    });
  }
  return columns;
}

function recoveryColumns(): readonly Column<RecoveryRequestSummary>[] {
  return [
    {
      key: 'created',
      header: t('web.recovery_started'),
      render: (row) => <span className="nowrap">{formatTimestamp(row.createdAt)}</span>,
    },
    {
      key: 'by',
      header: t('web.recovery_requested_by'),
      render: (row) => <span className="nowrap">{row.requestedBy ?? '—'}</span>,
    },
    {
      key: 'state',
      header: t('web.recovery_state'),
      render: (row) => (
        <Badge tone={stateTone(row.state)} title={row.state}>
          {t(RECOVERY_STATE_LABELS[row.state])}
        </Badge>
      ),
    },
    {
      key: 'stage',
      header: t('web.recovery_stage'),
      render: (row) => <span title={row.stage}>{t(RECOVERY_STAGE_LABELS[row.stage])}</span>,
    },
    {
      key: 'failure',
      header: t('web.recovery_failure'),
      // The failure in words, with the code under it for whoever reads the server log.
      render: (row) =>
        row.failureCode === null ? (
          '—'
        ) : (
          <>
            {recoveryFailureText(row.failureCode)}
            <br />
            <span className="muted small">
              <Ltr>{row.failureCode}</Ltr>
            </span>
          </>
        ),
    },
    {
      /*
       * The displaced database name, which is the single most important cell on
       * this table after a cutover: it is how an operator knows production is the
       * restored database and where the outgoing one still is. Nothing removes it
       * automatically, and ADR-0028 records that as a decision — it is the fastest
       * rollback that exists.
       */
      key: 'displaced',
      header: t('web.recovery_displaced'),
      render: (row) =>
        row.displacedDatabase === null ? '—' : <Copyable value={row.displacedDatabase} />,
    },
    {
      key: 'cutover',
      header: t('web.recovery_cutover_at'),
      render: (row) =>
        row.cutoverAt === null ? (
          '—'
        ) : (
          <span className="nowrap">{formatTimestamp(row.cutoverAt)}</span>
        ),
    },
  ];
}

/**
 * The Telegram delivery outcome.
 *
 * The prop is `outcome`, not `state`: `state={` is a token the query-view
 * contract scan forbids across `apps/web/src`, because `<StateSwitch state={…}>`
 * was the shape where a view computed its own loading state and got it out of
 * step with the query it was rendering. This component has nothing to do with
 * that, and a name that trips a guard is a name that gets the guard relaxed.
 */
function DeliveryBadge({ outcome }: { outcome: BackupRunSummary['deliveryState'] }) {
  if (outcome === 'SUCCEEDED')
    return <Badge tone="ok">{t('web.recovery_delivery_succeeded')}</Badge>;
  if (outcome === 'FAILED_DEFINITIVE')
    return <Badge tone="danger">{t('web.recovery_delivery_failed')}</Badge>;
  // The third outcome, and the reason the enum has four members: we sent bytes
  // and never learned the verdict. Rendered as its own state, never folded into
  // a failure.
  if (outcome === 'OUTCOME_UNKNOWN')
    return <Badge tone="warn">{t('web.recovery_delivery_unknown')}</Badge>;
  return <Badge tone="neutral">{t('web.recovery_delivery_not_attempted')}</Badge>;
}

/** Bytes as a string, because the wire carries a `bigint` as one. */
function Bytes({ value }: { value: string | null }) {
  if (value === null) return <>—</>;
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return <Ltr>{value}</Ltr>;
  return <Num value={Math.round(bytes / 1024)} />;
}

function triggerLabel(trigger: BackupRunSummary['trigger']): string {
  if (trigger === 'MANUAL') return t('web.recovery_trigger_manual');
  if (trigger === 'SCHEDULED') return t('web.recovery_trigger_scheduled');
  return t('web.recovery_trigger_pre_restore');
}

function runTone(run: BackupRunSummary): 'ok' | 'warn' | 'danger' | 'info' {
  if (run.state === 'FAILED') return 'danger';
  if (run.state === 'RUNNING') return 'info';
  return run.cleanupOk ? 'ok' : 'warn';
}

function stateTone(state: RecoveryRequestSummary['state']): 'ok' | 'warn' | 'danger' | 'info' {
  if (state === 'SUCCEEDED') return 'ok';
  if (state === 'FAILED') return 'danger';
  if (
    state === 'RESTORE_REQUESTED' ||
    state === 'PRE_RESTORE_BACKUP' ||
    state === 'QUIESCING' ||
    state === 'RESTORING' ||
    state === 'VALIDATING' ||
    state === 'CUTTING_OVER' ||
    state === 'RESTARTING'
  ) {
    return 'warn';
  }
  return 'info';
}
