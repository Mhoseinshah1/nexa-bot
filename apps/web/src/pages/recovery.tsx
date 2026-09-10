import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  RECOVERY_CONFIRMATION_PHRASE,
  isRecoveryConfirmationPhrase,
  type BackupRunSummary,
  type RecoveryRequestSummary,
} from '@nexa/contracts';
import {
  backupArchiveUrl,
  confirmRecovery,
  fetchBackupHistory,
  fetchBackupStatus,
  fetchRecoveries,
  fetchRecoveryCapabilities,
  newIdempotencyKey,
  runBackupNow,
  uploadRecoveryArchive,
  verifyRecovery,
  ApiError,
} from '../api/client';
import { formatTimestamp } from '../format';
import { t } from '../i18n/web.fa';
import { pollUnlessFinal } from '../polling';
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
  MaturityBadge,
  Num,
  PageHead,
  StateSwitch,
  type Column,
} from '../ui/kit';

/**
 * Backup and disaster recovery.
 *
 * Four sections, in the order an operator needs them: is the backup working,
 * what has it produced, what is the newest thing that could actually be
 * restored, and — last, because it is the dangerous one — restore from it.
 *
 * NOTHING HERE IS FAKE. Every control calls a real endpoint, and the two
 * capabilities this release does not have say so in the place an operator would
 * look for them rather than being hidden: uploading is reported off when it is
 * off, and foreign-installation archives are reported «پشتیبانی نمی‌شود»
 * because a missing button reads as an oversight and a refusal reads as a
 * decision.
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
  permissions: readonly string[];
}) {
  const onLink = useLinkHandler();
  const client = useQueryClient();
  const mayView = permissions.includes('backup.view');
  const mayRun = permissions.includes('backup.run');
  const mayDownload = permissions.includes('backup.download');
  const mayRestore = permissions.includes('recovery.restore');

  const cursor = route.query.get('cursor') ?? undefined;

  const status = useQuery({
    queryKey: ['backup-status'],
    queryFn: fetchBackupStatus,
    enabled: mayView,
    refetchInterval: pollUnlessFinal(STATUS_REFRESH_MS),
  });
  const history = useQuery({
    queryKey: ['backup-history', cursor ?? null],
    queryFn: () =>
      fetchBackupHistory({ limit: HISTORY_PAGE, ...(cursor === undefined ? {} : { cursor }) }),
    enabled: mayView,
    refetchInterval: pollUnlessFinal(STATUS_REFRESH_MS),
  });
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
  };

  const runNow = useMutation({
    mutationFn: () => runBackupNow({ idempotencyKey: newIdempotencyKey() }),
    onSuccess: refreshAll,
  });

  const runs = history.data?.runs ?? [];
  const nextCursor = history.data?.nextCursor ?? null;

  return (
    <>
      <PageHead title={t('web.recovery_title')} subtitle={t('web.recovery_intro')} maturity="now" />

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
          />
          <CursorPager
            onPrevious={() => setQuery(route, 'cursor', null)}
            onNext={() => setQuery(route, 'cursor', nextCursor)}
            hasPrevious={cursor !== undefined}
            hasNext={nextCursor !== null}
            shown={runs.length}
          />
        </StateSwitch>
      </Card>

      <Card title={t('web.recovery_operations_title')} hint={t('web.recovery_upload_hint')}>
        <StateSwitch query={capabilities} denied={!mayView}>
          <RecoveryOperations
            uploadEnabled={capabilities.data?.uploadEnabled ?? false}
            maxUploadBytes={capabilities.data?.maxUploadBytes ?? 0}
            mayRestore={mayRestore}
            onChanged={refreshAll}
          />
        </StateSwitch>
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
          />
        </StateSwitch>
      </Card>

      <Card title={t('web.recovery_foreign_unsupported')}>
        {/*
          Reported rather than omitted. ADR-0028: supporting a foreign archive
          means holding another installation's key, and the only ways to do that
          are a form that accepts one — forbidden — or a key-import feature that
          does not exist. A missing section would read as an oversight.
        */}
        <Banner tone="neutral" title={t('web.recovery_foreign_unsupported')}>
          {t('web.recovery_foreign_hint')}
        </Banner>
        <p className="muted small">
          <MaturityBadge value="unsupported" /> {t('web.recovery_foreign_unsupported')}
        </p>
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
      <KV
        items={[
          [
            t('web.recovery_schedule'),
            status.scheduleEnabled ? (
              <Badge tone="ok">{t('web.recovery_schedule_on')}</Badge>
            ) : (
              <Badge tone="warn">{t('web.recovery_schedule_off')}</Badge>
            ),
          ],
          [t('web.recovery_interval'), <Duration key="i" ms={status.intervalMs} />],
          [
            t('web.recovery_last_success'),
            status.lastSucceededAt === null ? (
              <Badge tone="danger">{t('web.recovery_never')}</Badge>
            ) : (
              formatTimestamp(status.lastSucceededAt)
            ),
          ],
          [t('web.recovery_unknown_deliveries'), <Num key="u" value={status.unknownDeliveries} />],
        ]}
      />

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
          <button type="button" className="btn" onClick={onRun} disabled={busy || status.quiesced}>
            {busy ? t('web.recovery_running_now') : t('web.recovery_run_now')}
          </button>
        </div>
      )}
      {/* BUSY is not a failure: one backup at a time is the invariant working. */}
      {outcome === 'BUSY' && <Banner tone="warn">{t('web.recovery_run_busy')}</Banner>}
      {outcome === 'COMPLETED' && <Banner tone="ok">{t('web.recovery_run_done')}</Banner>}
      {error !== null && error !== undefined && <Banner tone="danger">{safeMessage(error)}</Banner>}
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
    <>
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
          {newest.cleanupDetail ?? ''}
        </Banner>
      )}
      <DownloadControl run={newest} mayDownload={mayDownload} />
    </>
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
        {t('web.recovery_download')}
      </a>
    </div>
  );
}

/** Upload, verify, and — behind a typed confirmation — restore. */
function RecoveryOperations({
  uploadEnabled,
  maxUploadBytes,
  mayRestore,
  onChanged,
}: {
  uploadEnabled: boolean;
  maxUploadBytes: number;
  mayRestore: boolean;
  onChanged: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [tooLarge, setTooLarge] = useState(false);
  const [current, setCurrent] = useState<RecoveryRequestSummary | null>(null);
  const [phrase, setPhrase] = useState('');

  const upload = useMutation({
    mutationFn: (chosen: File) => uploadRecoveryArchive(chosen),
    onSuccess: (result) => {
      setCurrent(result.recovery);
      onChanged();
    },
  });
  const verify = useMutation({
    mutationFn: (id: string) => verifyRecovery(id),
    onSuccess: (result) => {
      setCurrent(result.recovery);
      onChanged();
    },
  });
  const confirm = useMutation({
    mutationFn: (input: { id: string; checksum: string }) =>
      confirmRecovery({
        id: input.id,
        phrase,
        artifactChecksum: input.checksum,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: (result) => {
      setCurrent(result.recovery);
      onChanged();
    },
  });

  if (!uploadEnabled) {
    return <Banner tone="neutral">{t('web.recovery_upload_disabled')}</Banner>;
  }

  const onChoose = (chosen: File | null): void => {
    setFile(chosen);
    // Refused HERE as well as on the server, so an operator is not made to
    // upload a gigabyte to be told the limit. The server's counter is still the
    // authority; this is a courtesy, and it reports the real configured limit
    // rather than a number this page invented.
    setTooLarge(chosen !== null && chosen.size > maxUploadBytes);
  };

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (file !== null && !tooLarge) upload.mutate(file);
  };

  return (
    <>
      <h3 className="card-subtitle">{t('web.recovery_upload_title')}</h3>
      <form onSubmit={onSubmit} className="stack">
        <label className="field">
          <span className="field-label">{t('web.recovery_upload_choose')}</span>
          <input
            type="file"
            onChange={(event) => onChoose(event.currentTarget.files?.[0] ?? null)}
          />
        </label>
        {tooLarge && <Banner tone="danger">{t('web.recovery_upload_too_large')}</Banner>}
        <div className="btn-group">
          <button
            type="submit"
            className="btn"
            disabled={file === null || tooLarge || upload.isPending}
          >
            {upload.isPending ? t('web.recovery_uploading') : t('web.recovery_upload_send')}
          </button>
        </div>
        {upload.error !== null && <Banner tone="danger">{safeMessage(upload.error)}</Banner>}
      </form>

      {current !== null && (
        <>
          <KV
            items={[
              [
                t('web.recovery_state'),
                <Badge key="s" tone={stateTone(current.state)}>
                  {current.state}
                </Badge>,
              ],
              [t('web.recovery_stage'), <Ltr key="g">{current.stage}</Ltr>],
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
                      <Ltr key="mv">{current.restoreTest.migrationVerdict}</Ltr>,
                    ],
                  ] as [React.ReactNode, React.ReactNode][])),
              ...(current.failureCode === null
                ? []
                : ([[t('web.recovery_failure'), <Ltr key="f">{current.failureCode}</Ltr>]] as [
                    React.ReactNode,
                    React.ReactNode,
                  ][])),
            ]}
          />

          {current.state === 'UPLOADED' && (
            <>
              <p className="muted small">{t('web.recovery_verify_hint')}</p>
              <div className="btn-group">
                <button
                  type="button"
                  className="btn"
                  onClick={() => verify.mutate(current.id)}
                  disabled={verify.isPending}
                >
                  {verify.isPending ? t('web.recovery_verifying') : t('web.recovery_verify')}
                </button>
              </div>
            </>
          )}
          {verify.error !== null && <Banner tone="danger">{safeMessage(verify.error)}</Banner>}

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
        </>
      )}
    </>
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
    <div className="stack">
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
          className="btn danger"
          onClick={onConfirm}
          disabled={!matches || busy || recovery.artifactChecksum === null}
        >
          {t('web.recovery_confirm_button')}
        </button>
      </div>
      {error !== null && error !== undefined && <Banner tone="danger">{safeMessage(error)}</Banner>}
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
      render: (run) => <Badge tone={runTone(run)}>{run.state}</Badge>,
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
      render: (row) => <Badge tone={stateTone(row.state)}>{row.state}</Badge>,
    },
    {
      key: 'stage',
      header: t('web.recovery_stage'),
      render: (row) => <Ltr>{row.stage}</Ltr>,
    },
    {
      key: 'failure',
      header: t('web.recovery_failure'),
      render: (row) => (row.failureCode === null ? '—' : <Ltr>{row.failureCode}</Ltr>),
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

/**
 * An error an operator may see, and never a raw exception.
 *
 * `ApiError` carries the server's own message, which is author-controlled and
 * safe to render. Anything else is reported as a generic failure: an unexpected
 * throw here is a `TypeError` or a `ZodError` whose message names internals, and
 * putting one on screen is how a stack trace ends up in a screenshot in a
 * ticket.
 */
function safeMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : t('web.error');
}
